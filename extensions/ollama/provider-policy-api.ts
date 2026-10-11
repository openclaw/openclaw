import { isCloudModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
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
  isOllamaCloudOrigin,
  OLLAMA_DEFAULT_BASE_URL,
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
  if (!providerConfig || typeof providerConfig !== "object") {
    return providerConfig;
  }

  const normalizedProviderId = (provider ?? "").trim().toLowerCase();
  if (normalizedProviderId !== "ollama") {
    return providerConfig;
  }

  return {
    ...providerConfig,
    baseUrl:
      typeof providerConfig.baseUrl === "string" && providerConfig.baseUrl.trim()
        ? providerConfig.baseUrl
        : OLLAMA_DEFAULT_BASE_URL,
    models: Array.isArray(providerConfig.models) ? providerConfig.models : [],
  };
}

/**
 * Runtime normalization only prepares compaction policy, not model-list fields.
 * Skip full plugin activation for the unchanged configured-row projection.
 */
export function projectConfiguredModelRow(ctx: ProviderNormalizeResolvedModelContext) {
  const provider = ctx.provider.trim().toLowerCase();
  return provider === "ollama" || provider === OLLAMA_CLOUD_PROVIDER_ID ? null : undefined;
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
