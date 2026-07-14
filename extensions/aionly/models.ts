/**
 * AIOnly model catalog helpers derived from the plugin manifest.
 */
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const AIONLY_MANIFEST_CATALOG = manifest.modelCatalog.providers.aionly;

/** Base URL for AIOnly OpenAI-compatible inference. */
export const AIONLY_BASE_URL = AIONLY_MANIFEST_CATALOG.baseUrl;
/** AIOnly model catalog entries from the plugin manifest. */
export const AIONLY_MODEL_CATALOG = AIONLY_MANIFEST_CATALOG.models;

/** Builds normalized AIOnly catalog model definitions. */
export function buildAIOnlyCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "aionly",
    catalog: AIONLY_MANIFEST_CATALOG,
  }).models;
}

/** Builds one normalized AIOnly model definition from a manifest entry. */
export function buildAIOnlyModelDefinition(
  model: (typeof AIONLY_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  const providerConfig = buildManifestModelProviderConfig({
    providerId: "aionly",
    catalog: { ...AIONLY_MANIFEST_CATALOG, models: [model] },
  });
  return expectDefined(providerConfig.models.at(0), "normalized AIOnly manifest model");
}
