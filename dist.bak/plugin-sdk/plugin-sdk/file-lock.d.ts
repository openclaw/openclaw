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
export declare function acquireFileLock(filePath: string, options: FileLockOptions): Promise<FileLockHandle>;
export declare function withFileLock<T>(filePath: string, options: FileLockOptions, fn: () => Promise<T>): Promise<T>;
