// @ts-check
const fetch = require('node-fetch').default;
const awsHelper = require('./aws');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const fse = require('fs-extra');
const async = require('async');
const util = require('util');
const debug = require('debug')('prairielearn:' + path.basename(__filename, '.js'));
const archiver = require('archiver');
const klaw = require('klaw');
const { v4: uuidv4 } = require('uuid');

const config = require('./config');
const logger = require('./logger');
const socketServer = require('./socket-server');
const chunks = require('./chunks');

const sqldb = require('../prairielib/lib/sql-db');
const sqlLoader = require('../prairielib/lib/sql-loader');
const ERR = require('async-stacktrace');
const sql = sqlLoader.loadSqlEquiv(__filename);

const zipDirectory = async function (source, zip) {
  const stream = fs.createWriteStream(zip);
  const archive = archiver('zip');

  await new Promise((resolve, reject) => {
    stream
      .on('open', () => {
        archive.pipe(stream);
        if (source) {
          archive.directory(source, false);
        }
        archive.on('error', (err) => {
          throw err;
        });
        archive.finalize();
      })
      .on('error', (err) => {
        reject(err);
      })
      .on('finish', () => {
        debug(`Zipped ${source} as ${zip} (${archive.pointer()} total bytes)`);
        resolve(zip);
      });
  });
};

module.exports = {
  async init() {
    module.exports._namespace = socketServer.io.of('/workspace');
    module.exports._namespace.on('connection', module.exports.connection);
  },

  /**
   * Called when a client connects to the workspace namespace.
   *
   * @param {import('socket.io').Socket} socket
   */
  connection(socket) {
    socket.on('joinWorkspace', (msg, callback) => {
      const workspace_id = msg.workspace_id;
      socket.join(`workspace-${workspace_id}`);

      sqldb.queryOneRow(sql.select_workspace, { workspace_id }, (err, result) => {
        if (ERR(err, callback)) return;
        const workspace = result.rows[0];

        // Immediately return the workspace state to the client, but continue
        // starting the workspace in the background.
        callback({
          workspace_id,
          state: workspace.state,
        });

        (async () => {
          try {
            await module.exports.startup(workspace_id, workspace.state);
          } catch (err) {
            logger.error(`Error starting workspace ${workspace_id}`, err);
            await module.exports.updateState(
              workspace_id,
              'stopped',
              `Error! Click "Reboot" to try again. Detail: ${err}`
            );
          }
        })();
      });
    });

    socket.on('heartbeat', (msg, callback) => {
      const workspace_id = msg.workspace_id;
      sqldb.queryOneRow(sql.update_workspace_heartbeat_at_now, { workspace_id }, (err, result) => {
        if (ERR(err, callback)) return;
        const heartbeat_at = result.rows[0].heartbeat_at;
        callback({
          workspace_id,
          heartbeat_at,
        });
      });
    });
  },

  /**
   * Emits a socket.io message for the given workspace.
   *
   * @param {string | number} workspaceId - The ID of the workspace.
   * @param {string} event - A string name for the event.
   * @param {...any} args - The arguments of the event.
   */
  emitMessageForWorkspace(workspaceId, event, ...args) {
    module.exports._namespace.to(`workspace-${workspaceId}`).emit(event, ...args);
  },

  /**
   * Updates a workspace's current message.
   *
   * @param {string | number} workspace_id - The workspace's id.
   * @param {string} message - The workspace's new message.
   * @param {boolean?} toDatabase - Whether to write the message to the database.
   */
  async updateMessage(workspace_id, message, toDatabase = true) {
    debug(`Setting workspaces.message to '${message}'`);
    if (toDatabase) await sqldb.callAsync('workspaces_message_update', [workspace_id, message]);
    module.exports.emitMessageForWorkspace(workspace_id, 'change:message', {
      workspace_id,
      message,
    });
  },

  /**
   * Updates a workspace's current state and message.
   *
   * @param {string | number} workspace_id - The workspace's id.
   * @param {string} state - The workspace's new state.
   * @param {string?} message - The workspace's new message.
   */
  async updateState(workspace_id, state, message = '') {
    // TODO: add locking
    debug(`Setting workspaces.state='${state}', workspaces.message='${message}'`);
    await sqldb.callAsync('workspaces_state_update', [workspace_id, state, message]);
    module.exports.emitMessageForWorkspace(workspace_id, 'change:state', {
      workspace_id,
      state,
      message,
    });
  },

  async controlContainer(workspace_id, action, options = {}) {
    const result = await sqldb.queryZeroOrOneRowAsync(sql.select_workspace_host, { workspace_id });
    if (result.rowCount === 0) {
      throw new Error(`No host for workspace_id=${workspace_id}`);
    }
    if (!config.workspaceEnable) return;

    const workspace_host = result.rows[0];
    const postJson = {
      workspace_id,
      action,
      options,
    };
    const res = await fetch(`http://${workspace_host.hostname}/`, {
      method: 'post',
      body: JSON.stringify(postJson),
      headers: { 'Content-Type': 'application/json' },
    });
    if (action === 'getGradedFiles') {
      const contentDisposition = res.headers.get('content-disposition');
      if (contentDisposition == null) throw new Error(`Content-Disposition is null`);
      const match = contentDisposition.match(/^attachment; filename="(.*)"$/);
      if (!match) throw new Error(`Content-Disposition format error: ${contentDisposition}`);
      const zipName = match[1];
      const zipPath = path.join(config.workspaceMainZipsDirectory, zipName);

      debug(`controlContainer: saving ${zipPath}`);
      let stream = fs.createWriteStream(zipPath);

      return new Promise((resolve, reject) => {
        stream
          .on('open', () => {
            res.body.pipe(stream);
          })
          .on('error', (err) => {
            reject(err);
          })
          .on('finish', () => {
            resolve(zipPath);
          });
      });
    }
    if (res.ok) return;

    // if there was an error, we should have an error message from the host
    const json = await res.json();
    throw new Error(`Error from workspace host: ${json.message}`);
  },

  async startup(workspace_id, state) {
    if (state !== 'uninitialized' && state !== 'stopped') return;

    let useInitialZip = state === 'uninitialized';

    /** @type {InitializeResult | null} */
    let initializeResult;
    if (state === 'uninitialized') {
      initializeResult = await module.exports.initialize(workspace_id);
    }

    // We don't lock the above call to `initialize()` because it contains
    // a fair amount of I/O and we don't want to hold a lock during a
    // potentially long operation. However, we will lock here to ensure
    // that we don't run into problems if `startup()` was called concurrently
    // somewhere else:
    //
    // - We don't want an interleaving of state transitions like this:
    //   stopped -> launching -> stopped -> launching
    // - We don't want multiple hosts trying to assign a host for the same
    //   workspace at the same time.
    let shouldAssignHost = false;
    await sqldb.runInTransactionAsync(async () => {
      // First, lock the workspace row.
      const workspaceResults = await sqldb.queryOneRowAsync(sql.select_and_lock_workspace, {
        workspace_id,
      });
      const workspace = workspaceResults.rows[0];

      // If the initial state was `uninitialized`, we should check if it's
      // still uninitialized. If so, we'll need to perform a state transition.
      const shouldTransitionToStopped =
        state === 'uninitialized' && workspace.state === 'uninitialized';
      if (shouldTransitionToStopped) {
        if (initializeResult !== null) {
          // First, move any existing directory out of the way to get a clean start. This
          // should never happen in production environments, but when running
          // workspaces locally in development, we may end up trying to reuse the
          // same workspace ID and thus directory, for instance if the database
          // is reset in the middle of testing. In that case, we want to ensure
          // that we don't try to write on top of an existing directory, as this
          // could lead to unexpected behavior.
          try {
            const timestampSuffix = new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '-');
            await fse.move(
              initializeResult.destinationPath,
              `${initializeResult.destinationPath}-bak-${timestampSuffix}`,
              {
                overwrite: true,
              }
            );
          } catch (err) {
            // If the directory couldn't be moved because it didn't exist, ignore the error.
            // But otherwise, rethrow it.
            if (err.code !== 'ENOENT') {
              throw err;
            }
          }

          // Next, move the newly created directory into place. This will be
          // done with a lock held, so we shouldn't worry about other processes
          // trying to work with these directories at the same time.
          await fse.move(initializeResult.sourcePath, initializeResult.destinationPath, {
            overwrite: true,
          });
        }
        await module.exports.updateState(workspace_id, 'stopped', 'Initialization complete');
      }

      // If the workspace is in the stopped state (or we just transitioned to it),
      // transition to the launching state.
      if (workspace.state === 'stopped' || shouldTransitionToStopped) {
        await module.exports.updateState(workspace_id, 'launching', 'Assigning workspace host');
        shouldAssignHost = true;
      }
    });

    // Bail out if needed; this should only ever occur if another host is
    // already trying to assign this host to a workspace.
    if (!shouldAssignHost) return;

    let workspace_host_id = null;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (attempt > config.workspaceLaunchingRetryAttempts) {
        throw new Error('Time exceeded to deploy more computational resources');
      }
      workspace_host_id = await module.exports.assignHost(workspace_id);
      if (workspace_host_id != null) {
        break; // success, we got a host
      }
      const t = attempt * config.workspaceLaunchingRetryIntervalSec;
      await module.exports.updateMessage(
        workspace_id,
        `Deploying more computational resources (${t} seconds elapsed)`
      );
      await util.promisify(setTimeout)(config.workspaceLaunchingRetryIntervalSec * 1000);
      attempt++;
    }
    await module.exports.updateMessage(workspace_id, 'Sending launch command to host');
    await module.exports.controlContainer(workspace_id, 'init', {
      useInitialZip,
    });
  },

  /**
   * @typedef {Object} InitializeResult
   * @property {string} sourcePath
   * @property {string} destinationPath
   */

  /**
   * This function constructs the initial state of a workspace. What exactly
   * this does depends on the storage method for workspace files:
   *
   * - If workspace files are stored in S3, we construct and upload a zip file
   *   of the workspace's initial files. S3 PUTs are atomic, so we don't need
   *   to worry about locking in the case where multiple hosts are trying to
   *   initialize the same workspace.
   *
   * - If workspace files are stored on the filesystem (most likely on an NFS
   *   volume, like EFS), we'll construct the initial directory on disk in a
   *   temporary location and then return the path to that directory, as well
   *   as the path that the directory should be moved to. The caller is
   *   responsible for obtaining a lock for this workspace and moving the
   *   directory into its final location. Locking ensures that multiple hosts
   *   can't clobber writes to the same workspace. This is mostly important on
   *   NFS volumes, where renames (moves) are not atomic.
   *
   * @param {string | number} workspace_id
   * @returns {Promise<InitializeResult | null>}
   */
  async initialize(workspace_id) {
    const { workspace, question, course } = (
      await sqldb.queryOneRowAsync(sql.select_workspace_data, { workspace_id })
    ).rows[0];
    const course_path = chunks.getRuntimeDirectoryForCourse(course);
    await chunks.ensureChunksForCourseAsync(course.id, {
      type: 'question',
      questionId: question.id,
    });

    // Update home directory location. We do this now to catch both first
    // time startups and when the workspace is being reset.
    const homedir_location = config.workspaceHomeDirLocation;
    workspace.homedir_location = homedir_location;
    await sqldb.queryOneRowAsync(sql.update_workspace_homedir_location, {
      workspace_id,
      homedir_location,
    });

    // local workspace files
    const localPath = `${course_path}/questions/${question.qid}/workspace`;

    // base workspace directory wherever we are uploading to
    const remoteDirName = `workspace-${workspace_id}-${workspace.version}`;
    const remotePath = `${remoteDirName}/current`;

    // Zip up initial files to config.workspaceMainZipsDirectory so that
    // we can upload them
    const now = new Date().toISOString().replace(/[-T:.]/g, '-');
    const localZipPath = path.join(
      config.workspaceMainZipsDirectory,
      `${remoteDirName}-${now}.zip`
    );

    // Check if we have any local files to upload
    let localPathExists;
    try {
      await fsPromises.stat(localPath);
      localPathExists = true;
    } catch (err) {
      localPathExists = false;
    }

    // upload files to s3/efs depending on how the workspace is configured
    if (workspace.homedir_location === 'S3') {
      await zipDirectory(localPathExists ? localPath : null, localZipPath);
      const remoteZipPath = `${remoteDirName}/initial.zip`;
      await awsHelper.uploadToS3Async(config.workspaceS3Bucket, remoteZipPath, localZipPath, false);

      if (localPathExists) {
        debug(`Syncing ${localPath} to ${remotePath}`);
        await awsHelper.uploadDirectoryToS3Async(config.workspaceS3Bucket, remotePath, localPath);
      }

      return null;
    } else if (workspace.homedir_location === 'FileSystem') {
      const root = config.workspaceHomeDirRoot;
      const destinationPath = path.join(root, remotePath);
      const sourcePath = `${destinationPath}-${uuidv4()}`;

      await fse.ensureDir(sourcePath);
      await fsPromises.chown(
        sourcePath,
        config.workspaceJobsDirectoryOwnerUid,
        config.workspaceJobsDirectoryOwnerGid
      );

      if (localPathExists) {
        debug(`Syncing ${localPath} to ${remotePath}`);
        await fse.copy(localPath, sourcePath);

        // Update permissions so that the directory and all contents are owned by the workspace user
        for await (const file of klaw(sourcePath)) {
          await fsPromises.chown(
            file.path,
            config.workspaceJobsDirectoryOwnerUid,
            config.workspaceJobsDirectoryOwnerGid
          );
        }
      }

      return {
        sourcePath,
        destinationPath,
      };
    } else {
      throw new Error(`Unknown backing file storage: ${workspace.homedir_location}`);
    }
  },

  async assignHost(workspace_id) {
    if (!config.workspaceEnable) return;

    const params = [workspace_id, config.workspaceLoadHostCapacity];
    const result = await sqldb.callOneRowAsync('workspace_hosts_assign_workspace', params);
    const workspace_host_id = result.rows[0].workspace_host_id;
    debug(`assignHost(): workspace_id=${workspace_id}, workspace_host_id=${workspace_host_id}`);
    return workspace_host_id; // null means we didn't assign a host
  },

  async getGradedFiles(workspace_id) {
    let zipPath;
    const workspace = (await sqldb.queryOneRowAsync(sql.select_workspace, { workspace_id }))
      .rows[0];

    if (workspace.state === 'uninitialized') {
      // there are no files yet
      return null;
    }

    if (workspace.state === 'running') {
      // Attempt to get the files directly from the host.
      try {
        const action = 'getGradedFiles';
        zipPath = await module.exports.controlContainer(workspace_id, action);
      } catch (err) {
        logger.error('Error getting graded files from container', err);
      }
    }

    // If this is null, something went wrong, so fall back to fetching from
    // either S3 or the filesystem.
    if (zipPath == null) {
      if (workspace.homedir_location === 'S3') {
        zipPath = await module.exports.getGradedFilesFromS3(workspace_id);
      } else if (workspace.homedir_location === 'FileSystem') {
        zipPath = await module.exports.getGradedFilesFromFileSystem(workspace_id);
      } else {
        throw new Error(`Unknown backing file storage: ${workspace.homedir_location}`);
      }
    }

    return zipPath;
  },

  async getGradedFilesFromFileSystem(workspace_id) {
    const { workspace_version, workspace_graded_files } = (
      await sqldb.queryOneRowAsync(sql.select_workspace_version_and_graded_files, { workspace_id })
    ).rows[0];
    const timestamp = new Date().toISOString().replace(/[-T:.]/g, '-');
    const zipPath = path.join(
      config.workspaceMainZipsDirectory,
      `workspace-${workspace_id}-${workspace_version}-${timestamp}.zip`
    );

    const archive = archiver('zip');
    const remoteName = `workspace-${workspace_id}-${workspace_version}`;

    // Zip files from filesystem to zip file
    await async.eachLimit(
      workspace_graded_files,
      config.workspaceJobsParallelLimit,
      async (file) => {
        try {
          const remotePath = path.join(config.workspaceHomeDirRoot, remoteName, 'current', file);
          await fsPromises.lstat(remotePath);
          debug(`Zipping graded file ${remotePath} into ${zipPath}`);
          archive.file(remotePath, { name: file });
        } catch (err) {
          debug(`Graded file ${file} does not exist`);
        }
      }
    );

    // Write zip file to disk
    const stream = fs.createWriteStream(zipPath);
    await new Promise((resolve, reject) => {
      stream
        .on('open', () => {
          archive.pipe(stream);
          archive.on('error', (err) => {
            throw err;
          });
          archive.finalize();
        })
        .on('error', (err) => {
          reject(err);
        })
        .on('finish', () => {
          debug(`Zipped graded files as ${zipPath} (${archive.pointer()} total bytes)`);
          resolve(zipPath);
        });
    });
    return zipPath;
  },

  async getGradedFilesFromS3(workspace_id) {
    debug('Getting graded files from S3');
    const result = await sqldb.queryOneRowAsync(sql.select_workspace_version_and_graded_files, {
      workspace_id,
    });
    const { workspace_version, workspace_graded_files } = result.rows[0];
    const timestamp = new Date().toISOString().replace(/[-T:.]/g, '-');
    const zipName = `workspace-${workspace_id}-${workspace_version}-${timestamp}`;
    const zipDir = path.join(config.workspaceMainZipsDirectory, zipName);
    const zipPath = `${zipDir}.zip`;

    // download graded files from S3 -> zip dir -> zip file
    // FIXME: stream straight from S3 -> zip file
    const archive = archiver('zip');
    const s3Name = `workspace-${workspace_id}-${workspace_version}`;
    await async.eachLimit(
      workspace_graded_files,
      config.workspaceJobsParallelLimit,
      async (file) => {
        try {
          const localPath = path.join(zipDir, file);
          const s3Path = path.join(s3Name, 'current', file);
          const options = {
            owner: config.workspaceJobsDirectoryOwnerUid,
            group: config.workspaceJobsDirectoryOwnerGid,
          };
          await awsHelper.downloadFromS3Async(config.workspaceS3Bucket, s3Path, localPath, options);
          await fsPromises.lstat(localPath);
          debug(`Zipping graded file ${localPath} into ${zipPath}`);
          archive.file(localPath, { name: file });
        } catch (err) {
          debug(`Graded file ${file} does not exist`);
        }
      }
    );

    // write zip file to disk
    const stream = fs.createWriteStream(zipPath);
    await new Promise((resolve, reject) => {
      stream
        .on('open', () => {
          archive.pipe(stream);
          archive.on('error', (err) => {
            throw err;
          });
          archive.finalize();
        })
        .on('error', (err) => {
          reject(err);
        })
        .on('finish', () => {
          debug(`Zipped graded files as ${zipPath} (${archive.pointer()} total bytes)`);
          resolve(zipPath);
        });
    });
    try {
      await fsPromises.rmdir(zipDir, { recursive: true });
    } catch (err) {
      logger.error(`Error deleting ${zipDir}`);
    }

    return zipPath;
  },
};
