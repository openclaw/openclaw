import {
  buildMeganovaModelDefinition,
  MEGANOVA_BASE_URL,
  MEGANOVA_DEFAULT_MODEL_REF,
  MEGANOVA_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { MEGANOVA_DEFAULT_MODEL_REF };

export function applyMeganovaProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "meganova",
    api: "openai-completions",
    baseUrl: MEGANOVA_BASE_URL,
    catalogModels: MEGANOVA_MODEL_CATALOG.map(buildMeganovaModelDefinition),
  });
}

export function applyMeganovaConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyMeganovaProviderConfig(cfg),
    MEGANOVA_DEFAULT_MODEL_REF,
  );
}
