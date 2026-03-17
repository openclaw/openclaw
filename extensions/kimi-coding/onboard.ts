import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
} from "../../src/commands/onboard-auth.config-shared.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import {
  buildKimiCodingProvider,
  KIMI_BASE_URL,
  KIMI_DEFAULT_MODEL_ID,
  KIMI_LEGACY_MODEL_ID,
} from "./provider-catalog.js";

export const KIMI_DEFAULT_MODEL_REF = `kimi/${KIMI_DEFAULT_MODEL_ID}`;
export const KIMI_LEGACY_MODEL_REF = `kimi/${KIMI_LEGACY_MODEL_ID}`;
export const KIMI_CODING_MODEL_REF = KIMI_DEFAULT_MODEL_REF;

export function applyKimiCodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[KIMI_DEFAULT_MODEL_REF] = {
    ...models[KIMI_DEFAULT_MODEL_REF],
    alias: models[KIMI_DEFAULT_MODEL_REF]?.alias ?? "Kimi Code",
  };
  models[KIMI_LEGACY_MODEL_REF] = {
    ...models[KIMI_LEGACY_MODEL_REF],
    alias: models[KIMI_LEGACY_MODEL_REF]?.alias ?? "Kimi Code",
  };

  const catalog = buildKimiCodingProvider().models ?? [];
  if (catalog.length === 0) {
    return cfg;
  }

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "kimi",
    api: "anthropic-messages",
    baseUrl: KIMI_BASE_URL,
    catalogModels: catalog,
  });
}

export function applyKimiCodeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyKimiCodeProviderConfig(cfg), KIMI_DEFAULT_MODEL_REF);
}
