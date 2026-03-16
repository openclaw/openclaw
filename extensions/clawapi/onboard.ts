import {
  buildClawApiModelDefinition,
  CLAWAPI_BASE_URL,
  CLAWAPI_DEFAULT_MODEL_REF,
  CLAWAPI_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { CLAWAPI_DEFAULT_MODEL_REF };

export function applyClawApiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[CLAWAPI_DEFAULT_MODEL_REF] = {
    ...models[CLAWAPI_DEFAULT_MODEL_REF],
    alias: models[CLAWAPI_DEFAULT_MODEL_REF]?.alias ?? "ClawAPI",
  };

  const clawApiModels = CLAWAPI_MODEL_CATALOG.map(buildClawApiModelDefinition);
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "clawapi",
    api: "openai-completions",
    baseUrl: CLAWAPI_BASE_URL,
    catalogModels: clawApiModels,
  });
}

export function applyClawApiConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyClawApiProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, CLAWAPI_DEFAULT_MODEL_REF);
}
