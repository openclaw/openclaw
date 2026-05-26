import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamWithPayloadPatch } from "../agents/pi-embedded-runner/stream-payload-utils.js";
import type { ProviderWrapStreamFnContext } from "./plugin-entry.js";
export type ProviderStreamWrapperFactory = ((streamFn: StreamFn | undefined) => StreamFn | undefined) | null | undefined | false;
export declare function composeProviderStreamWrappers(baseStreamFn: StreamFn | undefined, ...wrappers: ProviderStreamWrapperFactory[]): StreamFn | undefined;
/** @deprecated Bundled provider stream helper; do not use from third-party plugins. */
export declare function defaultToolStreamExtraParams(extraParams?: Record<string, unknown>): Record<string, unknown>;
export declare function createPayloadPatchStreamWrapper(baseStreamFn: StreamFn | undefined, patchPayload: (params: {
    payload: Record<string, unknown>;
    model: Parameters<StreamFn>[0];
    context: Parameters<StreamFn>[1];
    options: Parameters<StreamFn>[2];
}) => void, wrapperOptions?: {
    shouldPatch?: (params: {
        model: Parameters<StreamFn>[0];
        context: Parameters<StreamFn>[1];
        options: Parameters<StreamFn>[2];
    }) => boolean;
}): StreamFn;
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export declare function stripTrailingAnthropicAssistantPrefillWhenThinking(payload: Record<string, unknown>): number;
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export declare function createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn: StreamFn | undefined, onStripped?: (stripped: number) => void, wrapperOptions?: Parameters<typeof createPayloadPatchStreamWrapper>[2]): StreamFn;
/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
export type OpenAICompatibleThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
export declare function isOpenAICompatibleThinkingEnabled(params: {
    thinkingLevel: OpenAICompatibleThinkingLevel;
    options: Parameters<StreamFn>[2];
}): boolean;
/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
export type DeepSeekV4ThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
export type DeepSeekV4ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
export declare function createDeepSeekV4OpenAICompatibleThinkingWrapper(params: {
    baseStreamFn: StreamFn | undefined;
    thinkingLevel: DeepSeekV4ThinkingLevel;
    shouldPatchModel: (model: Parameters<StreamFn>[0]) => boolean;
    resolveReasoningEffort?: (thinkingLevel: DeepSeekV4ThinkingLevel) => DeepSeekV4ReasoningEffort;
    shouldBackfillAssistantReasoningContent?: (message: Record<string, unknown>) => boolean;
}): StreamFn | undefined;
/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
export declare function createThinkingOnlyFinalTextWrapper(params: {
    baseStreamFn: StreamFn | undefined;
    shouldPatchModel: (model: Parameters<StreamFn>[0]) => boolean;
}): StreamFn | undefined;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export type GoogleThinkingInputLevel = "off" | "minimal" | "low" | "medium" | "adaptive" | "high" | "max" | "xhigh";
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function isGoogleThinkingRequiredModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function isGoogleGemini25ThinkingBudgetModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function isGoogleGemini3ProModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function isGoogleGemini3FlashModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function isGoogleGemini3ThinkingLevelModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function resolveGoogleGemini3ThinkingLevel(params: {
    modelId?: string;
    thinkingLevel?: GoogleThinkingInputLevel;
    thinkingBudget?: number;
}): GoogleThinkingLevel | undefined;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function stripInvalidGoogleThinkingBudget(params: {
    thinkingConfig: Record<string, unknown>;
    modelId?: string;
}): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function sanitizeGoogleThinkingPayload(params: {
    payload: unknown;
    modelId?: string;
    thinkingLevel?: GoogleThinkingInputLevel;
}): void;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function createGoogleThinkingPayloadWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: GoogleThinkingInputLevel): StreamFn;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export declare function createGoogleThinkingStreamWrapper(ctx: ProviderWrapStreamFnContext): NonNullable<ProviderWrapStreamFnContext["streamFn"]>;
export { applyAnthropicPayloadPolicyToParams, resolveAnthropicPayloadPolicy, } from "../agents/anthropic-payload-policy.js";
export { applyAnthropicEphemeralCacheControlMarkers } from "../agents/pi-embedded-runner/anthropic-cache-control-payload.js";
export { createMoonshotThinkingWrapper, resolveMoonshotThinkingType, } from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export { streamWithPayloadPatch };
export { createToolStreamWrapper, createZaiToolStreamWrapper, } from "../agents/pi-embedded-runner/zai-stream-wrappers.js";
