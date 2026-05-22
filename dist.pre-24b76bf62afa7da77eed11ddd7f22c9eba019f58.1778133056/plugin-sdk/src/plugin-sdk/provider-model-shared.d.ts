import { buildAnthropicReplayPolicyForModel, buildGoogleGeminiReplayPolicy, buildHybridAnthropicOrOpenAIReplayPolicy, buildNativeAnthropicReplayPolicyForModel, buildOpenAICompatibleReplayPolicy, buildPassthroughGeminiSanitizingReplayPolicy, buildStrictAnthropicReplayPolicy, resolveTaggedReasoningOutputMode, sanitizeGoogleGeminiReplayHistory } from "../plugins/provider-replay-helpers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderThinkingProfile } from "./plugin-entry.js";
import { normalizeAntigravityPreviewModelId, normalizeGooglePreviewModelId, normalizeNativeXaiModelId } from "./provider-model-id-normalize.js";
export type { ModelApi, ModelProviderConfig } from "../config/types.models.js";
export type { BedrockDiscoveryConfig, ModelCompatConfig, ModelDefinitionConfig, } from "../config/types.models.js";
export type { ProviderEndpointClass, ProviderEndpointResolution, } from "../agents/provider-attribution.js";
export type { ProviderPlugin } from "../plugins/types.js";
export { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
export { GPT5_BEHAVIOR_CONTRACT, GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY, GPT5_FRIENDLY_PROMPT_OVERLAY, GPT5_HEARTBEAT_PROMPT_OVERLAY, isGpt5ModelId, normalizeGpt5PromptOverlayMode, renderGpt5PromptOverlay, resolveGpt5PromptOverlayMode, resolveGpt5SystemPromptContribution, type Gpt5PromptOverlayMode, } from "../agents/gpt5-prompt-overlay.js";
export { resolveProviderEndpoint } from "../agents/provider-attribution.js";
export { applyModelCompatPatch, hasToolSchemaProfile, hasNativeWebSearchTool, normalizeModelCompat, resolveUnsupportedToolSchemaKeywords, resolveToolCallArgumentsEncoding, } from "../plugins/provider-model-compat.js";
export { normalizeProviderId } from "../agents/provider-id.js";
export { buildAnthropicReplayPolicyForModel, buildGoogleGeminiReplayPolicy, buildHybridAnthropicOrOpenAIReplayPolicy, buildNativeAnthropicReplayPolicyForModel, buildOpenAICompatibleReplayPolicy, buildPassthroughGeminiSanitizingReplayPolicy, resolveTaggedReasoningOutputMode, sanitizeGoogleGeminiReplayHistory, buildStrictAnthropicReplayPolicy, };
export { createMoonshotThinkingWrapper, resolveMoonshotThinkingType, } from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export { cloneFirstTemplateModel, matchesExactOrPrefix, } from "../plugins/provider-model-helpers.js";
export declare function getModelProviderHint(modelId: string): string | null;
export declare function isProxyReasoningUnsupportedModelHint(modelId: string): boolean;
export declare function isClaudeOpus47ModelId(modelId: string): boolean;
export declare function isClaudeAdaptiveThinkingDefaultModelId(modelId: string): boolean;
export declare function resolveClaudeThinkingProfile(modelId: string): ProviderThinkingProfile;
export { normalizeAntigravityPreviewModelId, normalizeGooglePreviewModelId, normalizeNativeXaiModelId, };
export type ProviderReplayFamily = "openai-compatible" | "anthropic-by-model" | "native-anthropic-by-model" | "google-gemini" | "passthrough-gemini" | "hybrid-anthropic-openai";
type ProviderReplayFamilyHooks = Pick<ProviderPlugin, "buildReplayPolicy" | "sanitizeReplayHistory" | "resolveReasoningOutputMode">;
type BuildProviderReplayFamilyHooksOptions = {
    family: "openai-compatible";
    sanitizeToolCallIds?: boolean;
} | {
    family: "anthropic-by-model";
} | {
    family: "native-anthropic-by-model";
} | {
    family: "google-gemini";
} | {
    family: "passthrough-gemini";
} | {
    family: "hybrid-anthropic-openai";
    anthropicModelDropThinkingBlocks?: boolean;
};
export declare function buildProviderReplayFamilyHooks(options: BuildProviderReplayFamilyHooksOptions): ProviderReplayFamilyHooks;
export declare const OPENAI_COMPATIBLE_REPLAY_HOOKS: ProviderReplayFamilyHooks;
export declare const ANTHROPIC_BY_MODEL_REPLAY_HOOKS: ProviderReplayFamilyHooks;
export declare const NATIVE_ANTHROPIC_REPLAY_HOOKS: ProviderReplayFamilyHooks;
export declare const PASSTHROUGH_GEMINI_REPLAY_HOOKS: ProviderReplayFamilyHooks;
