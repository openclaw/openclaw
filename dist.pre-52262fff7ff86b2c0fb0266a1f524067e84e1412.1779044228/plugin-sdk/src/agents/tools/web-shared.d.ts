export type CacheEntry<T> = {
    value: T;
    expiresAt: number;
    insertedAt: number;
};
export declare const DEFAULT_TIMEOUT_SECONDS = 30;
export declare const DEFAULT_CACHE_TTL_MINUTES = 15;
export declare function resolveTimeoutSeconds(value: unknown, fallback: number): number;
export declare function resolveCacheTtlMs(value: unknown, fallbackMinutes: number): number;
export declare function normalizeCacheKey(value: string): string;
export declare function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): {
    value: T;
    cached: boolean;
} | null;
export declare function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void;
export declare function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal;
export type ReadResponseTextResult = {
    text: string;
    truncated: boolean;
    bytesRead: number;
};
export declare function readResponseText(res: Response, options?: {
    maxBytes?: number;
}): Promise<ReadResponseTextResult>;
