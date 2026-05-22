import { kn as ProviderWrapStreamFnContext } from "./types-BYigPDoy.js";
import { Context, streamSimple } from "@mariozechner/pi-ai";
import { StreamFn } from "@mariozechner/pi-agent-core";

//#region src/agents/pi-embedded-runner/stream-payload-utils.d.ts
declare function streamWithPayloadPatch(underlying: StreamFn, model: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1], options: Parameters<StreamFn>[2], patchPayload: (payload: Record<string, unknown>) => void): ReturnType<StreamFn>;
//#endregion
//#region src/agents/anthropic-payload-policy.d.ts
type AnthropicServiceTier = "auto" | "standard_only";
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
type AnthropicPayloadPolicy = {
  allowsServiceTier: boolean;
  cacheControl: AnthropicEphemeralCacheControl | undefined;
  serviceTier: AnthropicServiceTier | undefined;
};
declare function resolveAnthropicPayloadPolicy(input: AnthropicPayloadPolicyInput): AnthropicPayloadPolicy;
declare function applyAnthropicPayloadPolicyToParams(payloadObj: Record<string, unknown>, policy: AnthropicPayloadPolicy): void;
declare function applyAnthropicEphemeralCacheControlMarkers(payloadObj: Record<string, unknown>): void;
//#endregion
//#region src/agents/copilot-dynamic-headers.d.ts
declare function hasCopilotVisionInput(messages: Context["messages"]): boolean;
declare function buildCopilotDynamicHeaders(params: {
  messages: Context["messages"];
  hasImages: boolean;
}): Record<string, string>;
//#endregion
//#region src/agents/pi-embedded-runner/anthropic-family-cache-semantics.d.ts
declare function isAnthropicBedrockModel(modelId: string): boolean;
//#endregion
//#region src/agents/pi-embedded-runner/bedrock-stream-wrappers.d.ts
declare function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
//#endregion
//#region src/agents/pi-embedded-runner/zai-stream-wrappers.d.ts
/**
 * Inject `tool_stream=true` so tool-call deltas stream in real time.
 * Providers can disable this by setting `params.tool_stream=false`.
 */
declare function createToolStreamWrapper(baseStreamFn: StreamFn | undefined, enabled: boolean): StreamFn;
declare const createZaiToolStreamWrapper: typeof createToolStreamWrapper;
//#endregion
//#region src/plugin-sdk/provider-stream-shared.d.ts
type ProviderStreamWrapperFactory = ((streamFn: StreamFn | undefined) => StreamFn | undefined) | null | undefined | false;
declare function composeProviderStreamWrappers(baseStreamFn: StreamFn | undefined, ...wrappers: ProviderStreamWrapperFactory[]): StreamFn | undefined;
declare function defaultToolStreamExtraParams(extraParams?: Record<string, unknown>): Record<string, unknown>;
declare function decodeHtmlEntitiesInObject(value: unknown): unknown;
declare function wrapStreamMessageObjects(stream: ReturnType<typeof streamSimple>, transformMessage: (message: unknown) => void): ReturnType<typeof streamSimple>;
declare function createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
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
declare function stripTrailingAssistantPrefillMessages(payload: Record<string, unknown>): number;
declare function stripTrailingAnthropicAssistantPrefillWhenThinking(payload: Record<string, unknown>): number;
declare function createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn: StreamFn | undefined, onStripped?: (stripped: number) => void, wrapperOptions?: Parameters<typeof createPayloadPatchStreamWrapper>[2]): StreamFn;
type OpenAICompatibleThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
declare function isOpenAICompatibleThinkingEnabled(params: {
  thinkingLevel: OpenAICompatibleThinkingLevel;
  options: Parameters<StreamFn>[2];
}): boolean;
type DeepSeekV4ThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
type DeepSeekV4ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
declare function createDeepSeekV4OpenAICompatibleThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  thinkingLevel: DeepSeekV4ThinkingLevel;
  shouldPatchModel: (model: Parameters<StreamFn>[0]) => boolean;
  resolveReasoningEffort?: (thinkingLevel: DeepSeekV4ThinkingLevel) => DeepSeekV4ReasoningEffort;
}): StreamFn | undefined;
type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
type GoogleThinkingInputLevel = "off" | "minimal" | "low" | "medium" | "adaptive" | "high" | "max" | "xhigh";
declare function isGoogleThinkingRequiredModel(modelId: string): boolean;
declare function isGoogleGemini25ThinkingBudgetModel(modelId: string): boolean;
declare function isGoogleGemini3ProModel(modelId: string): boolean;
declare function isGoogleGemini3FlashModel(modelId: string): boolean;
declare function isGoogleGemini3ThinkingLevelModel(modelId: string): boolean;
declare function resolveGoogleGemini3ThinkingLevel(params: {
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
  thinkingBudget?: number;
}): GoogleThinkingLevel | undefined;
declare function stripInvalidGoogleThinkingBudget(params: {
  thinkingConfig: Record<string, unknown>;
  modelId?: string;
}): boolean;
declare function sanitizeGoogleThinkingPayload(params: {
  payload: unknown;
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
}): void;
declare function createGoogleThinkingPayloadWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: GoogleThinkingInputLevel): StreamFn;
declare function createGoogleThinkingStreamWrapper(ctx: ProviderWrapStreamFnContext): NonNullable<ProviderWrapStreamFnContext["streamFn"]>;
//#endregion
export { createBedrockNoCacheWrapper as A, sanitizeGoogleThinkingPayload as C, wrapStreamMessageObjects as D, stripTrailingAssistantPrefillMessages as E, applyAnthropicPayloadPolicyToParams as F, resolveAnthropicPayloadPolicy as I, streamWithPayloadPatch as L, buildCopilotDynamicHeaders as M, hasCopilotVisionInput as N, createToolStreamWrapper as O, applyAnthropicEphemeralCacheControlMarkers as P, resolveGoogleGemini3ThinkingLevel as S, stripTrailingAnthropicAssistantPrefillWhenThinking as T, isGoogleGemini3FlashModel as _, OpenAICompatibleThinkingLevel as a, isGoogleThinkingRequiredModel as b, createAnthropicThinkingPrefillPayloadWrapper as c, createGoogleThinkingStreamWrapper as d, createHtmlEntityToolCallArgumentDecodingWrapper as f, isGoogleGemini25ThinkingBudgetModel as g, defaultToolStreamExtraParams as h, GoogleThinkingLevel as i, isAnthropicBedrockModel as j, createZaiToolStreamWrapper as k, createDeepSeekV4OpenAICompatibleThinkingWrapper as l, decodeHtmlEntitiesInObject as m, DeepSeekV4ThinkingLevel as n, ProviderStreamWrapperFactory as o, createPayloadPatchStreamWrapper as p, GoogleThinkingInputLevel as r, composeProviderStreamWrappers as s, DeepSeekV4ReasoningEffort as t, createGoogleThinkingPayloadWrapper as u, isGoogleGemini3ProModel as v, stripInvalidGoogleThinkingBudget as w, isOpenAICompatibleThinkingEnabled as x, isGoogleGemini3ThinkingLevelModel as y };