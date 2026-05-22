//#region src/plugin-sdk/file-lock.d.ts
type FileLockOptions = {
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize?: boolean;
  };
  stale: number;
};
type FileLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
};
declare const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";
type FileLockTimeoutError = Error & {
  code: typeof FILE_LOCK_TIMEOUT_ERROR_CODE;
  lockPath: string;
};
declare function resetFileLockStateForTest(): void;
declare function drainFileLockStateForTest(): Promise<void>;
/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
declare function acquireFileLock(filePath: string, options: FileLockOptions): Promise<FileLockHandle>;
/** Run an async callback while holding a file lock, always releasing the lock afterward. */
declare function withFileLock<T>(filePath: string, options: FileLockOptions, fn: () => Promise<T>): Promise<T>;
//#endregion
export { acquireFileLock as a, withFileLock as c, FileLockTimeoutError as i, FileLockHandle as n, drainFileLockStateForTest as o, FileLockOptions as r, resetFileLockStateForTest as s, FILE_LOCK_TIMEOUT_ERROR_CODE as t };