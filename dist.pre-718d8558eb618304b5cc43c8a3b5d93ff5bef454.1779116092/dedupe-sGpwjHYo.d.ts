//#region src/infra/dedupe.d.ts
type DedupeCache = {
  check: (key: string | undefined | null, now?: number) => boolean;
  peek: (key: string | undefined | null, now?: number) => boolean;
  delete: (key: string | undefined | null) => void;
  clear: () => void;
  size: () => number;
};
type DedupeCacheOptions = {
  ttlMs: number;
  maxSize: number;
};
declare function createDedupeCache(options: DedupeCacheOptions): DedupeCache;
declare function resolveGlobalDedupeCache(key: symbol, options: DedupeCacheOptions): DedupeCache;
//#endregion
export { resolveGlobalDedupeCache as i, DedupeCacheOptions as n, createDedupeCache as r, DedupeCache as t };