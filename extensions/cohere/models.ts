/**
 * Cohere model catalog helpers derived from the plugin manifest.
 */
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const COHERE_MANIFEST_CATALOG = manifest.modelCatalog.providers.cohere;

export const COHERE_BASE_URL = COHERE_MANIFEST_CATALOG.baseUrl;
export const COHERE_MODEL_CATALOG = COHERE_MANIFEST_CATALOG.models;
export const COHERE_NORTH_MINI_CODE_MODEL_ID = "north-mini-code-1-0";

export function buildCohereCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "cohere",
    catalog: COHERE_MANIFEST_CATALOG,
  }).models;
}

export function buildCohereModelDefinition(
  model: (typeof COHERE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return buildManifestModelProviderConfig({
    providerId: "cohere",
    catalog: { ...COHERE_MANIFEST_CATALOG, models: [model] },
  }).models[0];
}
