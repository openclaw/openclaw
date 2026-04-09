import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildSiliconFlowModelDefinition,
  SILICONFLOW_BASE_URL,
  SILICONFLOW_MODEL_CATALOG,
} from "./api.js";

export const SILICONFLOW_DEFAULT_MODEL_REF = "siliconflow/Qwen/Qwen2.5-7B-Instruct";

export function applySiliconFlowProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[SILICONFLOW_DEFAULT_MODEL_REF] = {
    ...models[SILICONFLOW_DEFAULT_MODEL_REF],
    alias: models[SILICONFLOW_DEFAULT_MODEL_REF]?.alias ?? "SiliconFlow",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "siliconflow",
    api: "openai-completions",
    baseUrl: SILICONFLOW_BASE_URL,
    catalogModels: SILICONFLOW_MODEL_CATALOG.map(buildSiliconFlowModelDefinition),
  });
}

export function applySiliconFlowConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applySiliconFlowProviderConfig(cfg),
    SILICONFLOW_DEFAULT_MODEL_REF,
  );
}
