import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_DEFAULT_MODEL_REF,
  SYNTHETIC_MODEL_CATALOG,
} from "../../src/agents/synthetic-models.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
} from "../../src/commands/onboard-auth.config-shared.js";
import type { OpenClawConfig } from "../../src/config/config.js";

export { SYNTHETIC_DEFAULT_MODEL_REF };

export function applySyntheticProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[SYNTHETIC_DEFAULT_MODEL_REF] = {
    ...models[SYNTHETIC_DEFAULT_MODEL_REF],
    alias: models[SYNTHETIC_DEFAULT_MODEL_REF]?.alias ?? "MiniMax M2.5",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "synthetic",
    api: "anthropic-messages",
    baseUrl: SYNTHETIC_BASE_URL,
    catalogModels: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
  });
}

export function applySyntheticConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applySyntheticProviderConfig(cfg),
    SYNTHETIC_DEFAULT_MODEL_REF,
  );
}
