import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { getAllCachedNovitaModels } from "openclaw/plugin-sdk/provider-stream";
import {
  buildNovitaModelDefinition,
  NOVITA_BASE_URL,
  NOVITA_MODEL_CATALOG,
} from "./api.js";

export { NOVITA_BASE_URL };

/**
 * Get all cached models as an array of ModelDefinitionConfig.
 * Falls back to the static seed catalog if the API hasn't been fetched yet.
 */
function getAllModels(): ModelDefinitionConfig[] {
  const cached = getAllCachedNovitaModels();
  if (!cached || cached.size === 0) {
    // Fall back to the static seed catalog (3 models) while API fetch is in-flight.
    return NOVITA_MODEL_CATALOG.map(buildNovitaModelDefinition);
  }
  const models: ModelDefinitionConfig[] = [];
  for (const [id, caps] of cached) {
    models.push({
      id,
      name: caps.name,
      reasoning: caps.reasoning,
      input: caps.input,
      cost: caps.cost,
      contextWindow: caps.contextWindow,
      maxTokens: caps.maxTokens,
    });
  }
  return models;
}

/**
 * Build the Novita AI provider config with all available models.
 */
export function buildNovitaProvider(): ModelProviderConfig {
  return {
    baseUrl: NOVITA_BASE_URL,
    api: "openai-completions",
    models: getAllModels(),
  };
}
