type CacheRetention = "none" | "short" | "long";
export declare function isGooglePromptCacheEligible(params: {
    modelApi?: string;
    modelId?: string;
}): boolean;
export declare function resolveCacheRetention(extraParams: Record<string, unknown> | undefined, provider: string, modelApi?: string, modelId?: string): CacheRetention | undefined;
export {};
