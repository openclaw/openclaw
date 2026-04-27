export declare const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";
export type CacheTtlEntryData = {
    timestamp: number;
    provider?: string;
    modelId?: string;
};
type CacheTtlContext = {
    provider?: string;
    modelId?: string;
};
export declare function isCacheTtlEligibleProvider(provider: string, modelId: string, modelApi?: string): boolean;
export declare function readLastCacheTtlTimestamp(sessionManager: unknown, context?: CacheTtlContext): number | null;
export declare function appendCacheTtlTimestamp(sessionManager: unknown, data: CacheTtlEntryData): void;
export {};
