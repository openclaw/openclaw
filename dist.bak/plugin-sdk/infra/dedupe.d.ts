export type DedupeCache = {
    check: (key: string | undefined | null, now?: number) => boolean;
    peek: (key: string | undefined | null, now?: number) => boolean;
    clear: () => void;
    size: () => number;
};
type DedupeCacheOptions = {
    ttlMs: number;
    maxSize: number;
};
export declare function createDedupeCache(options: DedupeCacheOptions): DedupeCache;
export {};
