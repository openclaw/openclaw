import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "../../src/commands/onboard-auth.config-shared.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import {
  buildKimiCodingProvider,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const KIMI_CODING_MODEL_REF = `kimi-coding/${KIMI_CODING_DEFAULT_MODEL_ID}`;

export function applyKimiCodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[KIMI_CODING_MODEL_REF] = {
    ...models[KIMI_CODING_MODEL_REF],
    alias: models[KIMI_CODING_MODEL_REF]?.alias ?? "Kimi for Coding",
  };

  const defaultModel = buildKimiCodingProvider().models[0];
  if (!defaultModel) {
    return cfg;
  }

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "kimi-coding",
    api: "anthropic-messages",
    baseUrl: KIMI_CODING_BASE_URL,
    defaultModel,
    defaultModelId: KIMI_CODING_DEFAULT_MODEL_ID,
  });
}

export function applyKimiCodeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyKimiCodeProviderConfig(cfg), KIMI_CODING_MODEL_REF);
}
