export type CachedPricingTier = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** [startTokens, endTokens) — half-open interval on the input token axis. */
    range: [number, number];
};
export type CachedModelPricing = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Optional tiered pricing tiers sourced from LiteLLM or local config. */
    tieredPricing?: CachedPricingTier[];
};
export type GatewayModelPricingHealthSource = "openrouter" | "litellm" | "bootstrap" | "refresh";
export type GatewayModelPricingHealth = {
    state: "ok" | "degraded" | "disabled";
    sources: Array<{
        source: GatewayModelPricingHealthSource;
        state: "ok" | "degraded";
        lastFailureAt?: number;
        detail?: string;
    }>;
    lastFailureAt?: number;
    detail?: string;
};
export declare function replaceGatewayModelPricingCache(nextPricing: Map<string, CachedModelPricing>, nextCachedAt?: number): void;
export declare function clearGatewayModelPricingCacheState(): void;
export declare function recordGatewayModelPricingSourceFailure(source: GatewayModelPricingHealthSource, detail: string, failedAt?: number): void;
export declare function clearGatewayModelPricingSourceFailure(source: GatewayModelPricingHealthSource): void;
export declare function clearGatewayModelPricingFailures(): void;
export declare function getGatewayModelPricingHealth(params?: {
    enabled?: boolean;
}): GatewayModelPricingHealth;
export declare function getCachedGatewayModelPricing(params: {
    provider?: string;
    model?: string;
}): CachedModelPricing | undefined;
export declare function getGatewayModelPricingCacheMeta(): {
    cachedAt: number;
    ttlMs: number;
    size: number;
};
export declare function getGatewayModelPricingCacheFingerprint(): string;
export declare function resetGatewayModelPricingCacheForTest(): void;
export declare function setGatewayModelPricingForTest(entries: Array<{
    provider: string;
    model: string;
    pricing: CachedModelPricing;
}>): void;
