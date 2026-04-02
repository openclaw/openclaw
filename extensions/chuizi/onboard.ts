import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildChuiziModelDefinition, CHUIZI_BASE_URL, CHUIZI_MODEL_CATALOG } from "./api.js";

export const CHUIZI_DEFAULT_MODEL_REF = "chuizi/anthropic/claude-sonnet-4-6";

export function applyChuiziProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[CHUIZI_DEFAULT_MODEL_REF] = {
    ...models[CHUIZI_DEFAULT_MODEL_REF],
    alias: models[CHUIZI_DEFAULT_MODEL_REF]?.alias ?? "Chuizi",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "chuizi",
    api: "openai-completions",
    baseUrl: CHUIZI_BASE_URL,
    catalogModels: CHUIZI_MODEL_CATALOG.map(buildChuiziModelDefinition),
  });
}

export function applyChuiziConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyChuiziProviderConfig(cfg), CHUIZI_DEFAULT_MODEL_REF);
}
