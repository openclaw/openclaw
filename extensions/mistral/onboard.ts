import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "../../src/commands/onboard-auth.config-shared.js";
import {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
} from "../../src/commands/onboard-auth.models.js";
import type { OpenClawConfig } from "../../src/config/config.js";

export const MISTRAL_DEFAULT_MODEL_REF = `mistral/${MISTRAL_DEFAULT_MODEL_ID}`;

export function applyMistralProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MISTRAL_DEFAULT_MODEL_REF] = {
    ...models[MISTRAL_DEFAULT_MODEL_REF],
    alias: models[MISTRAL_DEFAULT_MODEL_REF]?.alias ?? "Mistral",
  };

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "mistral",
    api: "openai-completions",
    baseUrl: MISTRAL_BASE_URL,
    defaultModel: buildMistralModelDefinition(),
    defaultModelId: MISTRAL_DEFAULT_MODEL_ID,
  });
}

export function applyMistralConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyMistralProviderConfig(cfg), MISTRAL_DEFAULT_MODEL_REF);
}
