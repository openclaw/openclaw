// Ollama API module exposes the plugin public contract.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";
import { isReasoningModelHeuristic } from "./src/provider-models.js";

type OllamaProviderConfigDraft = Partial<ModelProviderConfig>;

const OLLAMA_REASONING_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
  defaultLevel: "off",
} satisfies ProviderThinkingProfile;

const OLLAMA_NON_REASONING_THINKING_PROFILE = {
  levels: [{ id: "off" }],
  defaultLevel: "off",
} satisfies ProviderThinkingProfile;

/**
 * Provider policy surface for Ollama: normalize provider configs used by
 * core defaults/normalizers. This runs during config defaults application and
 * normalization paths (not Zod validation).
 */
export function normalizeConfig({
  provider,
  providerConfig,
}: {
  provider: string;
  providerConfig: OllamaProviderConfigDraft;
}): OllamaProviderConfigDraft {
  if (!providerConfig || typeof providerConfig !== "object") {
    return providerConfig;
  }

  const normalizedProviderId = (provider ?? "").trim().toLowerCase();
  if (normalizedProviderId !== "ollama") {
    return providerConfig;
  }

  const next: OllamaProviderConfigDraft = { ...providerConfig };

  // If baseUrl is missing, empty, or whitespace-only, default to local Ollama host.
  if (typeof next.baseUrl !== "string" || !next.baseUrl.trim()) {
    next.baseUrl = OLLAMA_DEFAULT_BASE_URL;
  }

  // If models is missing/not an array, default to empty array to signal discovery.
  if (!Array.isArray(next.models)) {
    next.models = [];
  }

  return next;
}

export function resolveThinkingProfile(ctx: {
  provider: string;
  modelId: string;
  reasoning?: boolean;
}): ProviderThinkingProfile {
  const { reasoning, modelId } = ctx;
  // If catalog explicitly indicates not a reasoning model, respect that.
  if (reasoning === false) {
    return OLLAMA_NON_REASONING_THINKING_PROFILE;
  }
  // Treat as reasoning model if explicitly flagged or name matches known reasoning patterns.
  const effectiveReasoning = reasoning === true || isReasoningModelHeuristic(modelId);
  return effectiveReasoning ? OLLAMA_REASONING_THINKING_PROFILE : OLLAMA_NON_REASONING_THINKING_PROFILE;
}
