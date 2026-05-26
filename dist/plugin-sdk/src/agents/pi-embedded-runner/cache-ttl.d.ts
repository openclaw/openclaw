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
export {};
