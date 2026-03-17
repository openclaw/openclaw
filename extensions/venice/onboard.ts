import {
  buildVeniceModelDefinition,
  VENICE_BASE_URL,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { VENICE_DEFAULT_MODEL_REF };

export function applyVeniceProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[VENICE_DEFAULT_MODEL_REF] = {
    ...models[VENICE_DEFAULT_MODEL_REF],
    alias: models[VENICE_DEFAULT_MODEL_REF]?.alias ?? "Kimi K2.5",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "venice",
    api: "openai-completions",
    baseUrl: VENICE_BASE_URL,
    catalogModels: VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition),
  });
}

export function applyVeniceConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyVeniceProviderConfig(cfg), VENICE_DEFAULT_MODEL_REF);
}
