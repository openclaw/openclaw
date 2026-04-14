import type {
  ProviderIncompleteTurnRecoveryContext,
  ProviderIncompleteTurnRecoveryPolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

function stripProviderPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const match = /^([^/:]+)[/:](.+)$/.exec(trimmed);
  return normalizeLowercaseStringOrEmpty(match?.[2] ?? trimmed);
}

function supportsAnthropicReasoningRecovery(ctx: ProviderIncompleteTurnRecoveryContext): boolean {
  if (ctx.modelApi && ctx.modelApi !== "anthropic-messages") {
    return false;
  }
  return stripProviderPrefix(ctx.modelId ?? "").startsWith("claude-");
}

/**
 * Anthropic Claude runs can continue after replay-safe reasoning-only turns.
 * Leave generic empty-response recovery disabled until it is validated
 * separately for Anthropic transports.
 */
export function buildAnthropicIncompleteTurnRecoveryPolicy(
  ctx: ProviderIncompleteTurnRecoveryContext,
): ProviderIncompleteTurnRecoveryPolicy | undefined {
  if (!supportsAnthropicReasoningRecovery(ctx)) {
    return undefined;
  }
  return {
    reasoningOnly: {
      enabled: true,
      maxRetries: 2,
    },
  };
}
