import {
  buildModelScopeModelDefinition,
  MODELSCOPE_BASE_URL,
  MODELSCOPE_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const MODELSCOPE_DEFAULT_MODEL_REF = "modelscope/Qwen/Qwen3.5-27B";

export function applyModelScopeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MODELSCOPE_DEFAULT_MODEL_REF] = {
    ...models[MODELSCOPE_DEFAULT_MODEL_REF],
    alias: models[MODELSCOPE_DEFAULT_MODEL_REF]?.alias ?? "Hugging Face",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "modelscope",
    api: "openai-completions",
    baseUrl: MODELSCOPE_BASE_URL,
    catalogModels: MODELSCOPE_MODEL_CATALOG.map(buildModelScopeModelDefinition),
  });
}

export function applyModelScopeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyModelScopeProviderConfig(cfg),
    MODELSCOPE_DEFAULT_MODEL_REF,
  );
}
