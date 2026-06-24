/**
 * Manifest model catalog helpers derived from the plugin manifest.
 */
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const MANIFEST_MANIFEST_CATALOG = manifest.modelCatalog.providers.manifest;

/** Base URL for Manifest OpenAI-compatible routing endpoint. */
export const MANIFEST_BASE_URL = MANIFEST_MANIFEST_CATALOG.baseUrl;
/** Manifest model catalog entries from the plugin manifest. */
export const MANIFEST_MODEL_CATALOG = MANIFEST_MANIFEST_CATALOG.models;

/** Builds normalized Manifest catalog model definitions. */
export function buildManifestCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "manifest",
    catalog: MANIFEST_MANIFEST_CATALOG,
  }).models;
}

/** Builds one normalized Manifest model definition from a manifest entry. */
export function buildManifestModelDefinition(
  model: (typeof MANIFEST_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  const providerConfig = buildManifestModelProviderConfig({
    providerId: "manifest",
    catalog: { ...MANIFEST_MANIFEST_CATALOG, models: [model] },
  });
  return providerConfig.models[0];
}
