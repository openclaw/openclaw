import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ProviderReasoningOutputMode, ProviderReplayPolicy, ProviderReplayPolicyContext, ProviderSanitizeReplayHistoryContext } from "./types.js";
export declare function buildOpenAICompatibleReplayPolicy(modelApi: string | null | undefined, options?: {
    sanitizeToolCallIds?: boolean;
    modelId?: string | null;
}): ProviderReplayPolicy | undefined;
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
 */
export declare function shouldPreserveThinkingBlocks(modelId?: string): boolean;
export declare function buildAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy;
export declare function buildNativeAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy;
export declare function buildHybridAnthropicOrOpenAIReplayPolicy(ctx: ProviderReplayPolicyContext, options?: {
    anthropicModelDropThinkingBlocks?: boolean;
}): ProviderReplayPolicy | undefined;
export declare function buildGoogleGeminiReplayPolicy(): ProviderReplayPolicy;
export declare function buildPassthroughGeminiSanitizingReplayPolicy(modelId?: string): ProviderReplayPolicy;
export declare function sanitizeGoogleGeminiReplayHistory(ctx: ProviderSanitizeReplayHistoryContext): AgentMessage[];
export declare function resolveTaggedReasoningOutputMode(): ProviderReasoningOutputMode;
