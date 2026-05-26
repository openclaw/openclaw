import { Hn as ProviderWrapStreamFnContext } from "./types-Vx7Jq4_-2.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region src/agents/pi-embedded-runner/stream-payload-utils.d.ts
declare function streamWithPayloadPatch(underlying: StreamFn, model: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1], options: Parameters<StreamFn>[2], patchPayload: (payload: Record<string, unknown>) => void): ReturnType<StreamFn>;
//#endregion
//#region src/agents/anthropic-payload-policy.d.ts
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
type AnthropicServiceTier = "auto" | "standard_only";
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
type AnthropicEphemeralCacheControl = {
  type: "ephemeral";
  ttl?: "1h";
};
type AnthropicPayloadPolicyInput = {
  api?: string;
  baseUrl?: string;
  cacheRetention?: "short" | "long" | "none";
  enableCacheControl?: boolean;
  provider?: string;
  serviceTier?: AnthropicServiceTier;
};
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
type AnthropicPayloadPolicy = {
  allowsServiceTier: boolean;
  cacheControl: AnthropicEphemeralCacheControl | undefined;
  serviceTier: AnthropicServiceTier | undefined;
};
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
declare function resolveAnthropicPayloadPolicy(input: AnthropicPayloadPolicyInput): AnthropicPayloadPolicy;
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
declare function applyAnthropicPayloadPolicyToParams(payloadObj: Record<string, unknown>, policy: AnthropicPayloadPolicy): void;
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
declare function applyAnthropicEphemeralCacheControlMarkers(payloadObj: Record<string, unknown>): void;
//#endregion
//#region src/agents/pi-embedded-runner/zai-stream-wrappers.d.ts
/**
 * Inject `tool_stream=true` so tool-call deltas stream in real time.
 * Providers can disable this by setting `params.tool_stream=false`.
 *
 * @deprecated Provider-owned stream helper; do not use from third-party plugins.
 */
declare function createToolStreamWrapper(baseStreamFn: StreamFn | undefined, enabled: boolean): StreamFn;
/** @deprecated Z.ai provider-owned stream helper; do not use from third-party plugins. */
declare const createZaiToolStreamWrapper: typeof createToolStreamWrapper;
//#endregion
//#region src/plugin-sdk/provider-stream-shared.d.ts
type ProviderStreamWrapperFactory = ((streamFn: StreamFn | undefined) => StreamFn | undefined) | null | undefined | false;
declare function composeProviderStreamWrappers(baseStreamFn: StreamFn | undefined, ...wrappers: ProviderStreamWrapperFactory[]): StreamFn | undefined;
/** @deprecated Bundled provider stream helper; do not use from third-party plugins. */
declare function defaultToolStreamExtraParams(extraParams?: Record<string, unknown>): Record<string, unknown>;
declare function createPayloadPatchStreamWrapper(baseStreamFn: StreamFn | undefined, patchPayload: (params: {
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
declare function stripTrailingAnthropicAssistantPrefillWhenThinking(payload: Record<string, unknown>): number;
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
declare function createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn: StreamFn | undefined, onStripped?: (stripped: number) => void, wrapperOptions?: Parameters<typeof createPayloadPatchStreamWrapper>[2]): StreamFn;
/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
type OpenAICompatibleThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
declare function isOpenAICompatibleThinkingEnabled(params: {
  thinkingLevel: OpenAICompatibleThinkingLevel;
  options: Parameters<StreamFn>[2];
}): boolean;
/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
type DeepSeekV4ThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
type DeepSeekV4ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
declare function createDeepSeekV4OpenAICompatibleThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  thinkingLevel: DeepSeekV4ThinkingLevel;
  shouldPatchModel: (model: Parameters<StreamFn>[0]) => boolean;
  resolveReasoningEffort?: (thinkingLevel: DeepSeekV4ThinkingLevel) => DeepSeekV4ReasoningEffort;
  shouldBackfillAssistantReasoningContent?: (message: Record<string, unknown>) => boolean;
}): StreamFn | undefined;
/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
declare function createThinkingOnlyFinalTextWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  shouldPatchModel: (model: Parameters<StreamFn>[0]) => boolean;
}): StreamFn | undefined;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
type GoogleThinkingInputLevel = "off" | "minimal" | "low" | "medium" | "adaptive" | "high" | "max" | "xhigh";
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function isGoogleThinkingRequiredModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function isGoogleGemini25ThinkingBudgetModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function isGoogleGemini3ProModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function isGoogleGemini3FlashModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function isGoogleGemini3ThinkingLevelModel(modelId: string): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function resolveGoogleGemini3ThinkingLevel(params: {
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
  thinkingBudget?: number;
}): GoogleThinkingLevel | undefined;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function stripInvalidGoogleThinkingBudget(params: {
  thinkingConfig: Record<string, unknown>;
  modelId?: string;
}): boolean;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function sanitizeGoogleThinkingPayload(params: {
  payload: unknown;
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
}): void;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function createGoogleThinkingPayloadWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: GoogleThinkingInputLevel): StreamFn;
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
declare function createGoogleThinkingStreamWrapper(ctx: ProviderWrapStreamFnContext): NonNullable<ProviderWrapStreamFnContext["streamFn"]>;
//#endregion
export { streamWithPayloadPatch as A, stripInvalidGoogleThinkingBudget as C, applyAnthropicEphemeralCacheControlMarkers as D, createZaiToolStreamWrapper as E, applyAnthropicPayloadPolicyToParams as O, sanitizeGoogleThinkingPayload as S, createToolStreamWrapper as T, isGoogleGemini3ProModel as _, OpenAICompatibleThinkingLevel as a, isOpenAICompatibleThinkingEnabled as b, createAnthropicThinkingPrefillPayloadWrapper as c, createGoogleThinkingStreamWrapper as d, createPayloadPatchStreamWrapper as f, isGoogleGemini3FlashModel as g, isGoogleGemini25ThinkingBudgetModel as h, GoogleThinkingLevel as i, resolveAnthropicPayloadPolicy as k, createDeepSeekV4OpenAICompatibleThinkingWrapper as l, defaultToolStreamExtraParams as m, DeepSeekV4ThinkingLevel as n, ProviderStreamWrapperFactory as o, createThinkingOnlyFinalTextWrapper as p, GoogleThinkingInputLevel as r, composeProviderStreamWrappers as s, DeepSeekV4ReasoningEffort as t, createGoogleThinkingPayloadWrapper as u, isGoogleGemini3ThinkingLevelModel as v, stripTrailingAnthropicAssistantPrefillWhenThinking as w, resolveGoogleGemini3ThinkingLevel as x, isGoogleThinkingRequiredModel as y };