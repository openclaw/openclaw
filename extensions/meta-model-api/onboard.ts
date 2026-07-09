/**
 * Meta Model API onboarding config helpers.
 */
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildMetaModelApiModelDefinition,
  META_MODEL_API_BASE_URL,
  META_MODEL_API_MODEL_CATALOG,
} from "./models.js";

/** Default Meta Model API model reference used after onboarding. */
export const META_MODEL_API_DEFAULT_MODEL_REF = "meta-model-api/muse-spark-1.1";

const metaModelApiPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: META_MODEL_API_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "meta-model-api",
    api: "openai-responses",
    baseUrl: META_MODEL_API_BASE_URL,
    catalogModels: META_MODEL_API_MODEL_CATALOG.map(buildMetaModelApiModelDefinition),
    aliases: [{ modelRef: META_MODEL_API_DEFAULT_MODEL_REF, alias: "Muse Spark 1.1" }],
  }),
});

/** Applies Meta Model API provider/catalog config and default model aliases. */
export function applyMetaModelApiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return metaModelApiPresetAppliers.applyConfig(cfg);
}
