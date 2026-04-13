import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

export const PROVIDER_ID = "github-copilot";
const CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;

// Ordered preference list for local auto model selection.
// Prefer low-multiplier, broadly-available models (per GitHub Copilot docs).
// At runtime, the first one found in the model registry is used.
const AUTO_CANDIDATE_MODEL_IDS = [
  "gpt-5.4-mini",
  "gpt-4.1",
  "claude-haiku-4.5",
  "gpt-5.4",
  "claude-sonnet-4.6",
  "gpt-5.3-codex",
] as const;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

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

  const lowerModelId = normalizeOptionalLowercaseString(trimmedModelId) ?? "";

  // "auto" is a local virtual selector — not a real Copilot API model ID.
  // Resolve it to the best available concrete model from the registry.
  if (lowerModelId === "auto") {
    for (const candidateId of AUTO_CANDIDATE_MODEL_IDS) {
      const candidate = ctx.modelRegistry.find(
        PROVIDER_ID,
        candidateId,
      ) as ProviderRuntimeModel | null;
      if (candidate) {
        return normalizeModelCompat({ ...candidate } as ProviderRuntimeModel);
      }
    }
    // No candidate in registry yet (cold start / catalog not loaded).
    // Fall back to a broadly-available low-multiplier concrete model.
    return normalizeModelCompat({
      id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
      provider: PROVIDER_ID,
      api: resolveCopilotTransportApi("gpt-5.4-mini"),
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    } as ProviderRuntimeModel);
  }

  // If the model is already in the registry, let the normal path handle it.
  const existing = ctx.modelRegistry.find(PROVIDER_ID, lowerModelId);
  if (existing) {
    return undefined;
  }

  // For gpt-5.4 specifically, clone from the gpt-5.2-codex template
  // to preserve any special settings the registry has for codex models.
  if (lowerModelId === CODEX_GPT_54_MODEL_ID) {
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
  const reasoning = /^o[13](\b|$)/.test(lowerModelId);
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  } as ProviderRuntimeModel);
}
