import { findNormalizedProviderValue } from "openclaw/plugin-sdk/provider-auth";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  type ModelProviderConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildMinimaxApiModelDefinition,
  MINIMAX_API_BASE_URL,
  MINIMAX_CN_API_BASE_URL,
} from "./model-definitions.js";
import { MINIMAX_DEFAULT_MODEL_ID } from "./provider-models.js";

function applyMinimaxApiProviderConfigWithBaseUrl(
  cfg: OpenClawConfig,
  modelId: string,
  baseUrl: string,
): OpenClawConfig {
  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProvider = providers.minimax ?? findNormalizedProviderValue(providers, "minimax");
  const existingModels = existingProvider?.models ?? [];
  const apiModel = buildMinimaxApiModelDefinition(modelId);
  const hasApiModel = existingModels.some((model) => model.id === modelId);
  const mergedModels = hasApiModel ? existingModels : [...existingModels, apiModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {
    baseUrl,
    models: [],
  };
  const preservedApiKey =
    typeof existingApiKey === "string"
      ? existingApiKey.trim() === "" || existingApiKey.trim() === "minimax"
        ? undefined
        : existingApiKey
      : existingApiKey;
  providers.minimax = {
    ...existingProviderRest,
    baseUrl,
    api: "anthropic-messages",
    authHeader: true,
    ...(preservedApiKey ? { apiKey: preservedApiKey } : {}),
    models: mergedModels,
  };

  const models = { ...cfg.agents?.defaults?.models };
  const modelRef = `minimax/${modelId}`;
  models[modelRef] = {
    ...models[modelRef],
    alias: "Minimax",
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
}

export function applyMinimaxApiProviderConfig(
  cfg: OpenClawConfig,
  modelId = MINIMAX_DEFAULT_MODEL_ID,
): OpenClawConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, modelId, MINIMAX_API_BASE_URL);
}

export function applyMinimaxApiConfig(
  cfg: OpenClawConfig,
  modelId = MINIMAX_DEFAULT_MODEL_ID,
): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyMinimaxApiProviderConfig(cfg, modelId),
    `minimax/${modelId}`,
  );
}

export function applyMinimaxApiProviderConfigCn(
  cfg: OpenClawConfig,
  modelId = MINIMAX_DEFAULT_MODEL_ID,
): OpenClawConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, modelId, MINIMAX_CN_API_BASE_URL);
}

export function applyMinimaxApiConfigCn(
  cfg: OpenClawConfig,
  modelId = MINIMAX_DEFAULT_MODEL_ID,
): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyMinimaxApiProviderConfigCn(cfg, modelId),
    `minimax/${modelId}`,
  );
}
