import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  ARCEE_TRINITY_LARGE_THINKING_COMPAT,
  isArceeTrinityLargeThinkingModelId,
} from "./models.js";
import { normalizeArceeOpenRouterBaseUrl } from "./provider-catalog.js";

export function normalizeArceeProviderConfig(
  providerConfig: ModelProviderConfig,
): ModelProviderConfig {
  let changed = false;
  const normalizedBaseUrl = normalizeArceeOpenRouterBaseUrl(providerConfig.baseUrl);
  const baseUrl =
    normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
      ? normalizedBaseUrl
      : providerConfig.baseUrl;
  if (baseUrl !== providerConfig.baseUrl) {
    changed = true;
  }

  const hasModels = Array.isArray(providerConfig.models);
  const models = hasModels
    ? providerConfig.models.map((model) => {
        if (!isArceeTrinityLargeThinkingModelId(model.id)) {
          return model;
        }
        if (
          model.compat?.supportsReasoningEffort ===
            ARCEE_TRINITY_LARGE_THINKING_COMPAT.supportsReasoningEffort &&
          model.compat?.supportsTools === ARCEE_TRINITY_LARGE_THINKING_COMPAT.supportsTools
        ) {
          return model;
        }
        changed = true;
        return {
          ...model,
          compat: {
            ...model.compat,
            ...ARCEE_TRINITY_LARGE_THINKING_COMPAT,
          },
        };
      })
    : providerConfig.models;

  return changed
    ? { ...providerConfig, baseUrl, ...(hasModels ? { models } : {}) }
    : providerConfig;
}

export function normalizeConfig(params: { providerConfig: ModelProviderConfig }) {
  return normalizeArceeProviderConfig(params.providerConfig);
}
