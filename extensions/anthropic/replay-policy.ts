import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";

/**
 * Returns the provider-owned replay policy for Anthropic transports.
 */
export function buildAnthropicReplayPolicy(ctx: ProviderReplayPolicyContext): ProviderReplayPolicy {
  const modelId = ctx.modelId?.toLowerCase() ?? "";

  return {
    sanitizeMode: "full",
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
    preserveSignatures: true,
    repairToolUseResultPairing: true,
    validateAnthropicTurns: true,
    allowSyntheticToolResults: true,
    ...(modelId.includes("claude") ? { dropThinkingBlocks: true } : {}),
  };
}
