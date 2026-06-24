/**
 * Manifest onboarding config helpers.
 */
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildManifestModelDefinition,
  MANIFEST_BASE_URL,
  MANIFEST_MODEL_CATALOG,
} from "./models.js";

/** Default Manifest model reference used after onboarding. */
export const MANIFEST_DEFAULT_MODEL_REF = "manifest/auto";

const manifestPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: MANIFEST_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "manifest",
    api: "openai-completions",
    baseUrl: MANIFEST_BASE_URL,
    catalogModels: MANIFEST_MODEL_CATALOG.map(buildManifestModelDefinition),
    aliases: [{ modelRef: MANIFEST_DEFAULT_MODEL_REF, alias: "Manifest Auto" }],
  }),
});

/** Applies Manifest provider/catalog config and default model aliases. */
export function applyManifestConfig(cfg: OpenClawConfig): OpenClawConfig {
  return manifestPresetAppliers.applyConfig(cfg);
}
