import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  type ModelProviderConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  ABLITERATION_BASE_URL,
  ABLITERATION_DEFAULT_MODEL_REF,
  ABLITERATION_MODEL_CATALOG,
  ABLITERATION_PROVIDER_API,
  buildAbliterationModelDefinition,
} from "./models.js";

export { ABLITERATION_DEFAULT_MODEL_REF };

function applyAbliterationProviderConfigInternal(cfg: OpenClawConfig): OpenClawConfig {
  const providerId = "abliteration";
  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProvider = providers[providerId];
  const existingModels = existingProvider?.models ?? [];
  const catalogModels = ABLITERATION_MODEL_CATALOG.map(buildAbliterationModelDefinition);
  const mergedModels =
    existingModels.length > 0
      ? [
          ...existingModels,
          ...catalogModels.filter(
            (model) => !existingModels.some((existing) => existing.id === model.id),
          ),
        ]
      : catalogModels;
  const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
  const normalizedApiKey =
    typeof existingApiKey === "string" ? existingApiKey.trim() : existingApiKey;

  providers[providerId] = {
    ...existingProviderRest,
    api: ABLITERATION_PROVIDER_API,
    baseUrl: ABLITERATION_BASE_URL,
    authHeader: true,
    ...(typeof normalizedApiKey === "string"
      ? normalizedApiKey
        ? { apiKey: normalizedApiKey }
        : {}
      : normalizedApiKey != null
        ? { apiKey: normalizedApiKey }
        : {}),
    models: mergedModels.length > 0 ? mergedModels : catalogModels,
  };

  const agentModels = { ...cfg.agents?.defaults?.models };
  agentModels[ABLITERATION_DEFAULT_MODEL_REF] = {
    ...agentModels[ABLITERATION_DEFAULT_MODEL_REF],
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, {
    agentModels,
    providers,
  });
}

export function applyAbliterationProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAbliterationProviderConfigInternal(cfg);
}

export function applyAbliterationConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyAbliterationProviderConfigInternal(cfg),
    ABLITERATION_DEFAULT_MODEL_REF,
  );
}
