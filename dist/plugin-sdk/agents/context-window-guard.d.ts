import type { OpenClawConfig } from "../config/config.js";
export declare const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16000;
export declare const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32000;
export type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";
export type ContextWindowInfo = {
    tokens: number;
    source: ContextWindowSource;
};
export declare function resolveContextWindowInfo(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    modelId: string;
    modelContextWindow?: number;
    defaultTokens: number;
}): ContextWindowInfo;
export type ContextWindowGuardResult = ContextWindowInfo & {
    shouldWarn: boolean;
    shouldBlock: boolean;
};
export declare function evaluateContextWindowGuard(params: {
    info: ContextWindowInfo;
    warnBelowTokens?: number;
    hardMinTokens?: number;
}): ContextWindowGuardResult;
