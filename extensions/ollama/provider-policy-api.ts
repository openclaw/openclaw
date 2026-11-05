import {
  findNormalizedProviderValue,
  isCloudModelRef,
  normalizeProviderId,
} from "openclaw/plugin-sdk/model-ref-parse";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderNormalizeResolvedModelContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  ModelProviderConfig,
  ProviderToolSearchPolicyContext,
} from "openclaw/plugin-sdk/provider-model-types";
import {
  OLLAMA_CLOUD_PROVIDER_ID,
  OLLAMA_CLOUD_BASE_URL,
  isOllamaCloudOrigin,
  isHostedOllamaCloud,
  OLLAMA_DEFAULT_BASE_URL,
  resolveOllamaCloudDefaultModel,
  resolveOllamaOutputBudget,
} from "./src/defaults.js";
import { supportsOllamaCloudFullThinkingEffort } from "./src/model-reasoning.js";
import { readProviderBaseUrl, resolveOllamaBaseUrlForRun } from "./src/provider-base-url.js";

type OllamaProviderConfigDraft = Partial<ModelProviderConfig>;

function isHostedRoute({
  provider,
  modelId,
  baseUrl,
}: {
  provider: string;
  modelId: string;
  baseUrl?: string;
}): boolean {
  return (
    normalizeProviderId(provider) === OLLAMA_CLOUD_PROVIDER_ID ||
    isCloudModelRef(modelId) ||
    isOllamaCloudOrigin(baseUrl)
  );
}

export function normalizeResolvedModel({
  provider,
  model,
  config,
}: ProviderNormalizeResolvedModelContext) {
  const baseUrl = resolveOllamaBaseUrlForRun({
    modelBaseUrl: model.baseUrl,
    providerBaseUrl: readProviderBaseUrl(
      findNormalizedProviderValue(config?.models?.providers, provider),
    ),
  });
  if (model.api !== "ollama" || isHostedRoute({ provider, modelId: model.id, baseUrl })) {
    return undefined;
  }
  // Qwen3.5 maps native low to thinking-on, which can exhaust the summary deadline.
  // Keep ordinary server summaries efficient without restricting explicit effort.
  return { ...model, compactionThinkingDefault: "off" as const };
}

/** Server routes prefer discovery; known cloud routes keep the ordinary surface.
 * Untagged aliases retain the server default because configured rows have no remote-source metadata. */
export function resolveToolSearchMode({
  provider,
  modelId,
  baseUrl,
}: ProviderToolSearchPolicyContext): "tools" | false {
  return isHostedRoute({ provider, modelId, baseUrl }) ? false : "tools";
}

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
  const normalizedProviderId = provider.trim().toLowerCase();
  if (normalizedProviderId !== "ollama" && normalizedProviderId !== OLLAMA_CLOUD_PROVIDER_ID) {
    return providerConfig;
  }
  const baseUrl = providerConfig.baseUrl?.trim()
    ? providerConfig.baseUrl
    : normalizedProviderId === OLLAMA_CLOUD_PROVIDER_ID
      ? OLLAMA_CLOUD_BASE_URL
      : OLLAMA_DEFAULT_BASE_URL;
  const models: ModelProviderConfig["models"] = [];
  for (const model of providerConfig.models ?? []) {
    const cloudModel = resolveOllamaCloudDefaultModel(model.id);
    const remote =
      isHostedOllamaCloud(baseUrl) || normalizedProviderId === OLLAMA_CLOUD_PROVIDER_ID;
    if (
      model.maxTokens !== undefined ||
      (model.contextWindow === undefined && !cloudModel) ||
      (!remote && !isCloudModelRef(model.id) && !cloudModel)
    ) {
      models.push(model);
      continue;
    }
    models.push({
      ...model,
      maxTokens:
        providerConfig.maxTokens ??
        resolveOllamaOutputBudget({
          modelId: model.id,
          contextWindow: model.contextWindow,
          remote,
        }),
    });
  }
  return { ...providerConfig, baseUrl, models };
}

export function resolveThinkingProfile({
  modelId,
  provider,
  reasoning,
  api,
  thinkingLevelMap,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile {
  const isCloudRoute =
    normalizeProviderId(provider) === OLLAMA_CLOUD_PROVIDER_ID || isCloudModelRef(modelId);
  const supportsThinking =
    reasoning === true ||
    (reasoning === undefined && isCloudRoute && supportsOllamaCloudFullThinkingEffort(modelId));
  if (!supportsThinking) {
    return OLLAMA_NON_REASONING_THINKING_PROFILE;
  }
  if ((!api || api === "ollama") && thinkingLevelMap) {
    return {
      ...OLLAMA_REASONING_THINKING_PROFILE,
      levels: [
        { id: "off" },
        ...(thinkingLevelMap.minimal === "minimal" ? [{ id: "minimal" as const }] : []),
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        ...(thinkingLevelMap.xhigh === "xhigh" ? [{ id: "xhigh" as const }] : []),
        { id: "max" },
      ],
    };
  }
  return OLLAMA_REASONING_THINKING_PROFILE;
}
