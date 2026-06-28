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
  // Use a provider wildcard so all live-discovered Pioneer models are visible
  // in the model picker without needing to enumerate them in the allowlist.
  const models = { ...cfg.agents?.defaults?.models, "pioneer/*": {} };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "pioneer",
    api: "openai-completions",
    baseUrl: PIONEER_BASE_URL,
    catalogModels: PIONEER_MODEL_CATALOG.map(buildPioneerModelDefinition),
  });
}

export function applyPioneerConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyPioneerProviderConfig(cfg), PIONEER_DEFAULT_MODEL_REF);
}
