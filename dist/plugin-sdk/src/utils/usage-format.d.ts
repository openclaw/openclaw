import type { NormalizedUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
/**
 * A single tier in a tiered-pricing schedule.  Prices are expressed as
 * USD per-million tokens, just like the flat `ModelCostConfig` fields.
 *
 * `range` is a half-open interval `[start, end)` expressed in *input*
 * token counts.  The tiers MUST be sorted in ascending `range[0]` order
 * with no gaps.
 */
export type PricingTier = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** [startTokens, endTokens) — half-open interval on the input token axis. */
    range: [number, number];
};
export type ModelCostConfig = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Optional tiered pricing tiers.  When present, `estimateUsageCost`
     *  uses them instead of the flat rates above.  The flat rates still
     *  serve as the "default / first-tier" fallback for callers that are
     *  unaware of tiered pricing. */
    tieredPricing?: PricingTier[];
};
export type UsageTotals = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
};
export declare function formatTokenCount(value?: number): string;
export declare function formatUsd(value?: number): string | undefined;
export declare function resolveModelCostConfigFingerprint(config?: OpenClawConfig): string;
export declare function resolveModelCostConfig(params: {
    provider?: string;
    model?: string;
    config?: OpenClawConfig;
    allowPluginNormalization?: boolean;
}): ModelCostConfig | undefined;
export declare function estimateUsageCost(params: {
    usage?: NormalizedUsage | UsageTotals | null;
    cost?: ModelCostConfig;
}): number | undefined;
export declare function __resetUsageFormatCachesForTest(): void;
