import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { streamWithPayloadPatch } from "../agents/pi-embedded-runner/stream-payload-utils.js";
import type { ProviderWrapStreamFnContext } from "./plugin-entry.js";
export type ProviderStreamWrapperFactory = ((streamFn: StreamFn | undefined) => StreamFn | undefined) | null | undefined | false;
export declare function composeProviderStreamWrappers(baseStreamFn: StreamFn | undefined, ...wrappers: ProviderStreamWrapperFactory[]): StreamFn | undefined;
export declare function defaultToolStreamExtraParams(extraParams?: Record<string, unknown>): Record<string, unknown>;
export declare function decodeHtmlEntitiesInObject(value: unknown): unknown;
export declare function wrapStreamMessageObjects(stream: ReturnType<typeof streamSimple>, transformMessage: (message: unknown) => void): ReturnType<typeof streamSimple>;
export declare function createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
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
export declare function stripTrailingAssistantPrefillMessages(payload: Record<string, unknown>): number;
export declare function stripTrailingAnthropicAssistantPrefillWhenThinking(payload: Record<string, unknown>): number;
export declare function createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn: StreamFn | undefined, onStripped?: (stripped: number) => void, wrapperOptions?: Parameters<typeof createPayloadPatchStreamWrapper>[2]): StreamFn;
export type OpenAICompatibleThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
export declare function isOpenAICompatibleThinkingEnabled(params: {
    thinkingLevel: OpenAICompatibleThinkingLevel;
    options: Parameters<StreamFn>[2];
}): boolean;
export type DeepSeekV4ThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
export type DeepSeekV4ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export declare function createDeepSeekV4OpenAICompatibleThinkingWrapper(params: {
    baseStreamFn: StreamFn | undefined;
    thinkingLevel: DeepSeekV4ThinkingLevel;
    shouldPatchModel: (model: Parameters<StreamFn>[0]) => boolean;
    resolveReasoningEffort?: (thinkingLevel: DeepSeekV4ThinkingLevel) => DeepSeekV4ReasoningEffort;
}): StreamFn | undefined;
export type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
export type GoogleThinkingInputLevel = "off" | "minimal" | "low" | "medium" | "adaptive" | "high" | "max" | "xhigh";
export declare function isGoogleThinkingRequiredModel(modelId: string): boolean;
export declare function isGoogleGemini25ThinkingBudgetModel(modelId: string): boolean;
export declare function isGoogleGemini3ProModel(modelId: string): boolean;
export declare function isGoogleGemini3FlashModel(modelId: string): boolean;
export declare function isGoogleGemini3ThinkingLevelModel(modelId: string): boolean;
export declare function resolveGoogleGemini3ThinkingLevel(params: {
    modelId?: string;
    thinkingLevel?: GoogleThinkingInputLevel;
    thinkingBudget?: number;
}): GoogleThinkingLevel | undefined;
export declare function stripInvalidGoogleThinkingBudget(params: {
    thinkingConfig: Record<string, unknown>;
    modelId?: string;
}): boolean;
export declare function sanitizeGoogleThinkingPayload(params: {
    payload: unknown;
    modelId?: string;
    thinkingLevel?: GoogleThinkingInputLevel;
}): void;
export declare function createGoogleThinkingPayloadWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: GoogleThinkingInputLevel): StreamFn;
export declare function createGoogleThinkingStreamWrapper(ctx: ProviderWrapStreamFnContext): NonNullable<ProviderWrapStreamFnContext["streamFn"]>;
export { applyAnthropicPayloadPolicyToParams, resolveAnthropicPayloadPolicy, } from "../agents/anthropic-payload-policy.js";
export { buildCopilotDynamicHeaders, hasCopilotVisionInput, } from "../agents/copilot-dynamic-headers.js";
export { applyAnthropicEphemeralCacheControlMarkers } from "../agents/pi-embedded-runner/anthropic-cache-control-payload.js";
export { createBedrockNoCacheWrapper, isAnthropicBedrockModel, } from "../agents/pi-embedded-runner/bedrock-stream-wrappers.js";
export { createMoonshotThinkingWrapper, resolveMoonshotThinkingType, } from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export { streamWithPayloadPatch };
export { createToolStreamWrapper, createZaiToolStreamWrapper, } from "../agents/pi-embedded-runner/zai-stream-wrappers.js";
