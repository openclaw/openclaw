import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildNebiusModelDefinition, NEBIUS_BASE_URL, NEBIUS_MODEL_CATALOG } from "./api.js";

export const NEBIUS_DEFAULT_MODEL_REF = "nebius/deepseek-ai/DeepSeek-V3.2";

export function applyNebiusProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[NEBIUS_DEFAULT_MODEL_REF] = {
    ...models[NEBIUS_DEFAULT_MODEL_REF],
    alias: models[NEBIUS_DEFAULT_MODEL_REF]?.alias ?? "Nebius",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "nebius",
    api: "openai-completions",
    baseUrl: NEBIUS_BASE_URL,
    catalogModels: NEBIUS_MODEL_CATALOG.map(buildNebiusModelDefinition),
  });
}

export function applyNebiusConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyNebiusProviderConfig(cfg),
    NEBIUS_DEFAULT_MODEL_REF,
  );
}
