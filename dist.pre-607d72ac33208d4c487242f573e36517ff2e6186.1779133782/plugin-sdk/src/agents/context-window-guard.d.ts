import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const CONTEXT_WINDOW_HARD_MIN_TOKENS = 4000;
export declare const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 8000;
type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";
export type ContextWindowInfo = {
    tokens: number;
    referenceTokens?: number;
    source: ContextWindowSource;
};
export declare function resolveContextWindowInfo(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    modelId: string;
    modelContextTokens?: number;
    modelContextWindow?: number;
    defaultTokens: number;
}): ContextWindowInfo;
type ContextWindowGuardResult = ContextWindowInfo & {
    hardMinTokens: number;
    warnBelowTokens: number;
    shouldWarn: boolean;
    shouldBlock: boolean;
};
type ContextWindowGuardThresholds = {
    hardMinTokens: number;
    warnBelowTokens: number;
};
export declare function resolveContextWindowGuardThresholds(contextWindowTokens: number): ContextWindowGuardThresholds;
export declare function formatContextWindowWarningMessage(params: {
    provider: string;
    modelId: string;
    guard: ContextWindowGuardResult;
    runtimeBaseUrl?: string | null;
}): string;
export declare function formatContextWindowBlockMessage(params: {
    guard: ContextWindowGuardResult;
    runtimeBaseUrl?: string | null;
}): string;
export declare function evaluateContextWindowGuard(params: {
    info: ContextWindowInfo;
    warnBelowTokens?: number;
    hardMinTokens?: number;
}): ContextWindowGuardResult;
export {};
