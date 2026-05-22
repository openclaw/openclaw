export type DedupeCache = {
    check: (key: string | undefined | null, now?: number) => boolean;
    peek: (key: string | undefined | null, now?: number) => boolean;
    delete: (key: string | undefined | null) => void;
    clear: () => void;
    size: () => number;
};
export type DedupeCacheOptions = {
    ttlMs: number;
    maxSize: number;
};
export declare function createDedupeCache(options: DedupeCacheOptions): DedupeCache;
export declare function resolveGlobalDedupeCache(key: symbol, options: DedupeCacheOptions): DedupeCache;
