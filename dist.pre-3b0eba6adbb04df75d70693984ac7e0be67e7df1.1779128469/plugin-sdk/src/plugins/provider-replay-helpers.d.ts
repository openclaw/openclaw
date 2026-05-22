import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProviderReasoningOutputMode, ProviderReplayPolicy, ProviderReplayPolicyContext, ProviderSanitizeReplayHistoryContext } from "./types.js";
/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
export declare function buildOpenAICompatibleReplayPolicy(modelApi: string | null | undefined, options?: {
    sanitizeToolCallIds?: boolean;
    modelId?: string | null;
    dropReasoningFromHistory?: boolean;
}): ProviderReplayPolicy | undefined;
/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
export declare function buildStrictAnthropicReplayPolicy(options?: {
    dropThinkingBlocks?: boolean;
    sanitizeToolCallIds?: boolean;
    preserveNativeAnthropicToolUseIds?: boolean;
}): ProviderReplayPolicy;
/**
 * Returns true for Claude models that preserve thinking blocks in context
 * natively (Opus 4.5+, Sonnet 4.5+, Haiku 4.5+). For these models, dropping
 * thinking blocks from prior turns breaks prompt cache prefix matching.
 *
 * See: https://platform.claude.com/docs/en/build-with-claude/extended-thinking#differences-in-thinking-across-model-versions
 *
 * @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks.
 */
export declare function shouldPreserveThinkingBlocks(modelId?: string): boolean;
/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
export declare function buildAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy;
/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
export declare function buildNativeAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy;
/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
export declare function buildHybridAnthropicOrOpenAIReplayPolicy(ctx: ProviderReplayPolicyContext, options?: {
    anthropicModelDropThinkingBlocks?: boolean;
}): ProviderReplayPolicy | undefined;
/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
export declare function buildGoogleGeminiReplayPolicy(): ProviderReplayPolicy;
/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
export declare function buildPassthroughGeminiSanitizingReplayPolicy(modelId?: string): ProviderReplayPolicy;
/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
export declare function sanitizeGoogleGeminiReplayHistory(ctx: ProviderSanitizeReplayHistoryContext): AgentMessage[];
/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
export declare function resolveTaggedReasoningOutputMode(): ProviderReasoningOutputMode;
