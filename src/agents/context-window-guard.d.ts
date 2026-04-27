import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";
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
    modelContextTokens?: number;
    modelContextWindow?: number;
    defaultTokens: number;
}): ContextWindowInfo;
export type ContextWindowGuardResult = ContextWindowInfo & {
    shouldWarn: boolean;
    shouldBlock: boolean;
};
export type ContextWindowGuardHint = {
    endpointClass: ReturnType<typeof resolveProviderEndpoint>["endpointClass"];
    likelySelfHosted: boolean;
};
export declare function resolveContextWindowGuardHint(params: {
    runtimeBaseUrl?: string | null;
}): ContextWindowGuardHint;
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
