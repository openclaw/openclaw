import type {
  ProviderIncompleteTurnRecoveryContext,
  ProviderIncompleteTurnRecoveryPolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const GPT5_FAMILY_MODEL_ID_RE = /^gpt-5(?:[.o-]|$)/i;

function stripProviderPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const match = /^([^/:]+)[/:](.+)$/.exec(trimmed);
  return normalizeLowercaseStringOrEmpty(match?.[2] ?? trimmed);
}

function supportsVisibleAnswerRecovery(modelId?: string | null): boolean {
  const normalized = typeof modelId === "string" ? stripProviderPrefix(modelId) : "";
  return GPT5_FAMILY_MODEL_ID_RE.test(normalized);
}

/**
 * OpenAI-family GPT-5 runs can safely continue after replay-safe
 * reasoning-only and empty-response assistant turns.
 */
export function buildOpenAIIncompleteTurnRecoveryPolicy(
  ctx: ProviderIncompleteTurnRecoveryContext,
): ProviderIncompleteTurnRecoveryPolicy | undefined {
  if (!supportsVisibleAnswerRecovery(ctx.modelId)) {
    return undefined;
  }
  return {
    reasoningOnly: {
      enabled: true,
      maxRetries: 2,
    },
    emptyResponse: {
      enabled: true,
      maxRetries: 1,
    },
  };
}
