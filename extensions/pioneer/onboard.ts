// Pioneer setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildPioneerModelDefinition,
  PIONEER_BASE_URL,
  PIONEER_DEFAULT_MODEL_ID,
  PIONEER_DEFAULT_MODEL_REF,
  PIONEER_MODEL_CATALOG,
} from "./models.js";

function applyPioneerProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[PIONEER_DEFAULT_MODEL_REF] = {
    ...models[PIONEER_DEFAULT_MODEL_REF],
    alias: models[PIONEER_DEFAULT_MODEL_REF]?.alias ?? "Pioneer",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "pioneer",
    api: "openai-completions",
    baseUrl: PIONEER_BASE_URL,
    defaultModelId: PIONEER_DEFAULT_MODEL_ID,
    catalogModels: PIONEER_MODEL_CATALOG.map(buildPioneerModelDefinition),
  });
}

export function applyPioneerConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyPioneerProviderConfig(cfg), PIONEER_DEFAULT_MODEL_REF);
}
