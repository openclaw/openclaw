import type { FileLockOptions } from "./file-lock.js";
export type PersistentDedupeOptions = {
    ttlMs: number;
    memoryMaxSize: number;
    fileMaxEntries: number;
    resolveFilePath: (namespace: string) => string;
    lockOptions?: Partial<FileLockOptions>;
    onDiskError?: (error: unknown) => void;
};
export type PersistentDedupeCheckOptions = {
    namespace?: string;
    now?: number;
    onDiskError?: (error: unknown) => void;
};
export type PersistentDedupe = {
    checkAndRecord: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
    clearMemory: () => void;
    memorySize: () => number;
};
export declare function createPersistentDedupe(options: PersistentDedupeOptions): PersistentDedupe;
