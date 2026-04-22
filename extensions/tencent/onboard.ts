import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildTokenHubModelDefinition,
  buildTokenPlanModelDefinition,
  TOKENHUB_BASE_URL,
  TOKENHUB_MODEL_CATALOG,
  TOKENHUB_PROVIDER_ID,
  TOKEN_PLAN_BASE_URL,
  TOKEN_PLAN_MODEL_CATALOG,
  TOKEN_PLAN_PROVIDER_ID,
} from "./api.js";

// ---------- TokenHub ----------

export const TOKENHUB_DEFAULT_MODEL_REF = `${TOKENHUB_PROVIDER_ID}/hy3-preview`;

function applyTokenHubProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[TOKENHUB_DEFAULT_MODEL_REF] = {
    ...models[TOKENHUB_DEFAULT_MODEL_REF],
    // Provider-specific alias to keep alias resolution deterministic when
    // both Tencent providers are enabled (see buildModelAliasIndex).
    alias: models[TOKENHUB_DEFAULT_MODEL_REF]?.alias ?? "Hy3 preview (TokenHub)",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: TOKENHUB_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: TOKENHUB_BASE_URL,
    catalogModels: TOKENHUB_MODEL_CATALOG.map(buildTokenHubModelDefinition),
  });
}

export function applyTokenHubConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyTokenHubProviderConfig(cfg),
    TOKENHUB_DEFAULT_MODEL_REF,
  );
}

// ---------- Token Plan ----------

export const TOKEN_PLAN_DEFAULT_MODEL_REF = `${TOKEN_PLAN_PROVIDER_ID}/hy3-preview`;

function applyTokenPlanProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[TOKEN_PLAN_DEFAULT_MODEL_REF] = {
    ...models[TOKEN_PLAN_DEFAULT_MODEL_REF],
    // Provider-specific alias to keep alias resolution deterministic when
    // both Tencent providers are enabled (see buildModelAliasIndex).
    alias: models[TOKEN_PLAN_DEFAULT_MODEL_REF]?.alias ?? "Hy3 preview (Token Plan)",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: TOKEN_PLAN_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: TOKEN_PLAN_BASE_URL,
    catalogModels: TOKEN_PLAN_MODEL_CATALOG.map(buildTokenPlanModelDefinition),
  });
}

export function applyTokenPlanConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyTokenPlanProviderConfig(cfg),
    TOKEN_PLAN_DEFAULT_MODEL_REF,
  );
}
