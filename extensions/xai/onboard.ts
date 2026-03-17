import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "../../src/commands/onboard-auth.config-shared.js";
import {
  buildXaiModelDefinition,
  XAI_BASE_URL,
  XAI_DEFAULT_MODEL_ID,
} from "../../src/commands/onboard-auth.models.js";
import type { OpenClawConfig } from "../../src/config/config.js";

export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;

export function applyXaiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[XAI_DEFAULT_MODEL_REF] = {
    ...models[XAI_DEFAULT_MODEL_REF],
    alias: models[XAI_DEFAULT_MODEL_REF]?.alias ?? "Grok",
  };

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "xai",
    api: "openai-completions",
    baseUrl: XAI_BASE_URL,
    defaultModel: buildXaiModelDefinition(),
    defaultModelId: XAI_DEFAULT_MODEL_ID,
  });
}

export function applyXaiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyXaiProviderConfig(cfg), XAI_DEFAULT_MODEL_REF);
}
