import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildTokenHubModelDefinition,
  buildTokenPlanModelDefinition,
  TOKENHUB_BASE_URL,
  TOKENHUB_MODEL_CATALOG,
  TOKEN_PLAN_BASE_URL,
  TOKEN_PLAN_MODEL_CATALOG,
} from "./models.js";

export function buildTokenHubProvider(): ModelProviderConfig {
  return {
    baseUrl: TOKENHUB_BASE_URL,
    api: "openai-completions",
    models: TOKENHUB_MODEL_CATALOG.map(buildTokenHubModelDefinition),
  };
}

export function buildTokenPlanProvider(): ModelProviderConfig {
  return {
    baseUrl: TOKEN_PLAN_BASE_URL,
    api: "openai-completions",
    models: TOKEN_PLAN_MODEL_CATALOG.map(buildTokenPlanModelDefinition),
  };
}
