import {
  buildHuggingfaceModelDefinition,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
} from "../../src/agents/huggingface-models.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
} from "../../src/commands/onboard-auth.config-shared.js";
import type { OpenClawConfig } from "../../src/config/config.js";

export const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";

export function applyHuggingfaceProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[HUGGINGFACE_DEFAULT_MODEL_REF] = {
    ...models[HUGGINGFACE_DEFAULT_MODEL_REF],
    alias: models[HUGGINGFACE_DEFAULT_MODEL_REF]?.alias ?? "Hugging Face",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "huggingface",
    api: "openai-completions",
    baseUrl: HUGGINGFACE_BASE_URL,
    catalogModels: HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition),
  });
}

export function applyHuggingfaceConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyHuggingfaceProviderConfig(cfg),
    HUGGINGFACE_DEFAULT_MODEL_REF,
  );
}
