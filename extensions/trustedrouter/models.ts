/**
 * TrustedRouter model catalog helpers derived from the plugin manifest.
 */
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const TRUSTEDROUTER_MANIFEST_CATALOG = manifest.modelCatalog.providers.trustedrouter;

/** Base URL for TrustedRouter OpenAI-compatible inference. */
export const TRUSTEDROUTER_BASE_URL = TRUSTEDROUTER_MANIFEST_CATALOG.baseUrl;
/** TrustedRouter model catalog entries from the plugin manifest. */
export const TRUSTEDROUTER_MODEL_CATALOG = TRUSTEDROUTER_MANIFEST_CATALOG.models;

/** Builds normalized TrustedRouter catalog model definitions. */
export function buildTrustedRouterCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "trustedrouter",
    catalog: TRUSTEDROUTER_MANIFEST_CATALOG,
  }).models;
}

/** Builds one normalized TrustedRouter model definition from a manifest entry. */
export function buildTrustedRouterModelDefinition(
  model: (typeof TRUSTEDROUTER_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  const providerConfig = buildManifestModelProviderConfig({
    providerId: "trustedrouter",
    catalog: { ...TRUSTEDROUTER_MANIFEST_CATALOG, models: [model] },
  });
  return providerConfig.models[0];
}
