// TokenLab setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildTokenLabModelDefinition,
  TOKENLAB_BASE_URL,
  TOKENLAB_DEFAULT_MODEL_REF,
  TOKENLAB_MODEL_CATALOG,
} from "./models.js";

function applyTokenLabProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[TOKENLAB_DEFAULT_MODEL_REF] = {
    ...models[TOKENLAB_DEFAULT_MODEL_REF],
    alias: models[TOKENLAB_DEFAULT_MODEL_REF]?.alias ?? "TokenLab",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "tokenlab",
    api: "openai-completions",
    baseUrl: TOKENLAB_BASE_URL,
    catalogModels: TOKENLAB_MODEL_CATALOG.map(buildTokenLabModelDefinition),
  });
}

export function applyTokenLabConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyTokenLabProviderConfig(cfg),
    TOKENLAB_DEFAULT_MODEL_REF,
  );
}
