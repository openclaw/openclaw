import type { NormalizedUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/config.js";
export type ModelCostConfig = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
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
export declare function resolveModelCostConfig(params: {
    provider?: string;
    model?: string;
    config?: OpenClawConfig;
}): ModelCostConfig | undefined;
export declare function estimateUsageCost(params: {
    usage?: NormalizedUsage | UsageTotals | null;
    cost?: ModelCostConfig;
}): number | undefined;
