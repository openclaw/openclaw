/**
 * Meta Model API model catalog helpers derived from the plugin manifest.
 */
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const META_MODEL_API_MANIFEST_CATALOG = manifest.modelCatalog.providers["meta-model-api"];

/** Base URL for Meta Model API OpenAI-compatible inference. */
export const META_MODEL_API_BASE_URL = META_MODEL_API_MANIFEST_CATALOG.baseUrl;
/** Meta Model API model catalog entries from the plugin manifest. */
export const META_MODEL_API_MODEL_CATALOG = META_MODEL_API_MANIFEST_CATALOG.models;

/** Builds normalized Meta Model API catalog model definitions. */
export function buildMetaModelApiCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "meta-model-api",
    catalog: META_MODEL_API_MANIFEST_CATALOG,
  }).models;
}

/** Builds one normalized Meta Model API model definition from a manifest entry. */
export function buildMetaModelApiModelDefinition(
  model: (typeof META_MODEL_API_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  const providerConfig = buildManifestModelProviderConfig({
    providerId: "meta-model-api",
    catalog: { ...META_MODEL_API_MANIFEST_CATALOG, models: [model] },
  });
  return providerConfig.models[0];
}
