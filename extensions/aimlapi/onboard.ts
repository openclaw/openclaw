import {
  AIMLAPI_BASE_URL,
  AIMLAPI_DEFAULT_MODEL_ID,
  AIMLAPI_DEFAULT_MODEL_REF,
  buildAimlapiModelDefinition,
} from "openclaw/plugin-sdk/aimlapi";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { AIMLAPI_DEFAULT_MODEL_REF };

export function applyAimlapiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[AIMLAPI_DEFAULT_MODEL_REF] = {
    ...models[AIMLAPI_DEFAULT_MODEL_REF],
    alias: models[AIMLAPI_DEFAULT_MODEL_REF]?.alias ?? "AI/ML API",
  };

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "aimlapi",
    api: "openai-completions",
    baseUrl: AIMLAPI_BASE_URL,
    defaultModel: buildAimlapiModelDefinition(),
    defaultModelId: AIMLAPI_DEFAULT_MODEL_ID,
  });
}

export function applyAimlapiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyAimlapiProviderConfig(cfg), AIMLAPI_DEFAULT_MODEL_REF);
}
