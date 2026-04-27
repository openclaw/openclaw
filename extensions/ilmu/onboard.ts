import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildIlmuModelDefinition, ILMU_BASE_URL, ILMU_MODEL_CATALOG } from "./api.js";

export const ILMU_DEFAULT_MODEL_REF = "ilmu/nemo-super";

export function applyIlmuProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[ILMU_DEFAULT_MODEL_REF] = {
    ...models[ILMU_DEFAULT_MODEL_REF],
    alias: models[ILMU_DEFAULT_MODEL_REF]?.alias ?? "ILMU",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "ilmu",
    api: "openai-completions",
    baseUrl: ILMU_BASE_URL,
    catalogModels: ILMU_MODEL_CATALOG.map(buildIlmuModelDefinition),
  });
}

export function applyIlmuConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyIlmuProviderConfig(cfg), ILMU_DEFAULT_MODEL_REF);
}
