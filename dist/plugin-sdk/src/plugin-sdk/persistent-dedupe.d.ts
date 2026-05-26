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
    hasRecent: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
    warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
    clearMemory: () => void;
    memorySize: () => number;
};
export type ClaimableDedupeClaimResult = {
    kind: "claimed";
} | {
    kind: "duplicate";
} | {
    kind: "inflight";
    pending: Promise<boolean>;
};
export type ClaimableDedupeOptions = {
    ttlMs: number;
    memoryMaxSize: number;
    resolveFilePath: (namespace: string) => string;
    fileMaxEntries: number;
    lockOptions?: Partial<FileLockOptions>;
    onDiskError?: (error: unknown) => void;
} | {
    ttlMs: number;
    memoryMaxSize: number;
    resolveFilePath?: undefined;
    fileMaxEntries?: undefined;
    lockOptions?: undefined;
    onDiskError?: undefined;
};
export type ClaimableDedupe = {
    claim: (key: string, options?: PersistentDedupeCheckOptions) => Promise<ClaimableDedupeClaimResult>;
    commit: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
    release: (key: string, options?: {
        namespace?: string;
        error?: unknown;
    }) => void;
    hasRecent: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
    warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
    clearMemory: () => void;
    memorySize: () => number;
};
/** Create a dedupe helper that combines in-memory fast checks with a lock-protected disk store. */
export declare function createPersistentDedupe(options: PersistentDedupeOptions): PersistentDedupe;
/** Create a claim/commit/release dedupe guard backed by memory and optional persistent storage. */
export declare function createClaimableDedupe(options: ClaimableDedupeOptions): ClaimableDedupe;
