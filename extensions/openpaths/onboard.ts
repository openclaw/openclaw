import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildOpenPathsModelDefinition,
  OPENPATHS_BASE_URL,
  OPENPATHS_MODEL_CATALOG,
} from "./api.js";

export const OPENPATHS_DEFAULT_MODEL_REF = "openpaths/auto-medium-task";

export function applyOpenPathsProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENPATHS_DEFAULT_MODEL_REF] = {
    ...models[OPENPATHS_DEFAULT_MODEL_REF],
    alias: models[OPENPATHS_DEFAULT_MODEL_REF]?.alias ?? "OpenPaths",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "openpaths",
    api: "openai-completions",
    baseUrl: OPENPATHS_BASE_URL,
    catalogModels: OPENPATHS_MODEL_CATALOG.map(buildOpenPathsModelDefinition),
  });
}

export function applyOpenPathsConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyOpenPathsProviderConfig(cfg),
    OPENPATHS_DEFAULT_MODEL_REF,
  );
}
