export declare function resolveCacheTtlMs(params: {
    envValue: string | undefined;
    defaultTtlMs: number;
}): number;
export declare function isCacheEnabled(ttlMs: number): boolean;
type CacheTtlResolver = number | (() => number);
type CachePruneIntervalResolver = number | ((ttlMs: number) => number);
type ExpiringMapCache<TKey, TValue> = {
    get: (key: TKey) => TValue | undefined;
    set: (key: TKey, value: TValue) => void;
    delete: (key: TKey) => void;
    clear: () => void;
    keys: () => TKey[];
    size: () => number;
    pruneExpired: () => void;
};
export declare function createExpiringMapCache<TKey, TValue>(options: {
    ttlMs: CacheTtlResolver;
    pruneIntervalMs?: CachePruneIntervalResolver;
    clock?: () => number;
}): ExpiringMapCache<TKey, TValue>;
type FileStatSnapshot = {
    mtimeMs: number;
    sizeBytes: number;
};
export declare function getFileStatSnapshot(filePath: string): FileStatSnapshot | undefined;
export {};
