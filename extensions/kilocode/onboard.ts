import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
} from "../../src/commands/onboard-auth.config-shared.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import {
  KILOCODE_BASE_URL,
  KILOCODE_DEFAULT_MODEL_REF,
} from "../../src/providers/kilocode-shared.js";
import { buildKilocodeProvider } from "./provider-catalog.js";

export { KILOCODE_BASE_URL, KILOCODE_DEFAULT_MODEL_REF };

export function applyKilocodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[KILOCODE_DEFAULT_MODEL_REF] = {
    ...models[KILOCODE_DEFAULT_MODEL_REF],
    alias: models[KILOCODE_DEFAULT_MODEL_REF]?.alias ?? "Kilo Gateway",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "kilocode",
    api: "openai-completions",
    baseUrl: KILOCODE_BASE_URL,
    catalogModels: buildKilocodeProvider().models ?? [],
  });
}

export function applyKilocodeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyKilocodeProviderConfig(cfg),
    KILOCODE_DEFAULT_MODEL_REF,
  );
}
