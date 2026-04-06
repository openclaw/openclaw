import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildArceeModelDefinition, ARCEE_BASE_URL, ARCEE_MODEL_CATALOG } from "./api.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function buildArceeProvider(): ModelProviderConfig {
  return {
    baseUrl: ARCEE_BASE_URL,
    api: "openai-completions",
    models: ARCEE_MODEL_CATALOG.map(buildArceeModelDefinition),
  };
}

export function buildArceeOpenRouterProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: ARCEE_MODEL_CATALOG.map(buildArceeModelDefinition),
  };
}
