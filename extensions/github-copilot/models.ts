import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

export const PROVIDER_ID = "github-copilot";
const CODEX_FORWARD_COMPAT_TARGET_IDS = new Set(["gpt-5.4", "gpt-5.3-codex"]);
// gpt-5.3-codex is only a useful template when gpt-5.4 is the target; it is
// always a registry miss (and therefore skipped) when it is the target itself.
const CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"] as const;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Known capability overrides for Copilot model variants whose limits diverge from
 * the synthetic catch-all defaults. Keys are the lowercased model id as it appears
 * in GitHub Copilot's `/models` response.
 *
 * These mirror what Copilot's upstream `/models` endpoint advertises in
 * `capabilities.limits` and `capabilities.supports`. The synthetic resolver and the
 * built-in default registry both consult this table so context windows, output
 * limits, and reasoning flags stay accurate without requiring users to set
 * agents.defaults.models[<id>] overrides in openclaw.json.
 */
export type CopilotKnownCapabilities = {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
};

const COPILOT_KNOWN_CAPABILITIES: Readonly<Record<string, CopilotKnownCapabilities>> = {
  // Long-context Opus 4.6 variant exposed by Copilot. Upstream advertises a 1M
  // input window, 64K output, and adaptive thinking up to high effort.
  "claude-opus-4.6-1m": {
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    reasoning: true,
  },
  // Long-context Opus 4.7 variant exposed by Copilot. Upstream advertises a 1M
  // input window, 64K output, and adaptive thinking up to xhigh effort.
  "claude-opus-4.7-1m-internal": {
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    reasoning: true,
  },
};

export function resolveCopilotKnownCapabilities(
  modelId: string,
): CopilotKnownCapabilities | undefined {
  const key = normalizeOptionalLowercaseString(modelId) ?? "";
  return key ? COPILOT_KNOWN_CAPABILITIES[key] : undefined;
}

function isCopilotCodexModelId(modelId: string): boolean {
  return /(?:^|[-_.])codex(?:$|[-_.])/.test(modelId);
}

export function resolveCopilotTransportApi(
  modelId: string,
): "anthropic-messages" | "openai-responses" {
  return (normalizeOptionalLowercaseString(modelId) ?? "").includes("claude")
    ? "anthropic-messages"
    : "openai-responses";
}

export function resolveCopilotForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  if (!trimmedModelId) {
    return undefined;
  }

  // If the model is already in the registry, let the normal path handle it.
  const lowerModelId = normalizeOptionalLowercaseString(trimmedModelId) ?? "";
  const existing = ctx.modelRegistry.find(PROVIDER_ID, lowerModelId);
  if (existing) {
    return undefined;
  }

  // For gpt-5.4 and gpt-5.3-codex, clone from a registered codex template
  // to inherit the correct reasoning and capability flags.
  if (CODEX_FORWARD_COMPAT_TARGET_IDS.has(lowerModelId)) {
    for (const templateId of CODEX_TEMPLATE_MODEL_IDS) {
      const template = ctx.modelRegistry.find(
        PROVIDER_ID,
        templateId,
      ) as ProviderRuntimeModel | null;
      if (!template) {
        continue;
      }
      return normalizeModelCompat({
        ...template,
        id: trimmedModelId,
        name: trimmedModelId,
      } as ProviderRuntimeModel);
    }
    // Template not found — fall through to synthetic catch-all below.
  }

  // Catch-all: create a synthetic model definition for any unknown model ID.
  // The Copilot API is OpenAI-compatible and will return its own error if the
  // model isn't available on the user's plan. This lets new models be used
  // by simply adding them to agents.defaults.models in openclaw.json — no
  // code change required.
  const known = resolveCopilotKnownCapabilities(trimmedModelId);
  const reasoning =
    known?.reasoning ?? (/^o[13](\b|$)/.test(lowerModelId) || isCopilotCodexModelId(lowerModelId));
  return normalizeModelCompat({
    id: trimmedModelId,
    name: trimmedModelId,
    provider: PROVIDER_ID,
    api: resolveCopilotTransportApi(trimmedModelId),
    reasoning,
    // Optimistic: most Copilot models support images, and the API rejects
    // image payloads for text-only models rather than failing silently.
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: known?.maxTokens ?? DEFAULT_MAX_TOKENS,
  } as ProviderRuntimeModel);
}
