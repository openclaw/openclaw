export type FileLockOptions = {
    retries: {
        retries: number;
        factor: number;
        minTimeout: number;
        maxTimeout: number;
        randomize?: boolean;
    };
    stale: number;
};
export type FileLockHandle = {
    lockPath: string;
    release: () => Promise<void>;
};
export declare const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";
export type FileLockTimeoutError = Error & {
    code: typeof FILE_LOCK_TIMEOUT_ERROR_CODE;
    lockPath: string;
};
export declare function resetFileLockStateForTest(): void;
export declare function drainFileLockStateForTest(): Promise<void>;
/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
export declare function acquireFileLock(filePath: string, options: FileLockOptions): Promise<FileLockHandle>;
/** Run an async callback while holding a file lock, always releasing the lock afterward. */
export declare function withFileLock<T>(filePath: string, options: FileLockOptions, fn: () => Promise<T>): Promise<T>;
