// CoreWeave onboarding config helpers for API-key setup.
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildCoreweaveModelDefinition,
  COREWEAVE_BASE_URL,
  COREWEAVE_DEFAULT_MODEL_REF,
  COREWEAVE_MODEL_CATALOG,
} from "./models.js";

export { COREWEAVE_DEFAULT_MODEL_REF };

const coreweavePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: COREWEAVE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "coreweave",
    api: "openai-completions",
    baseUrl: COREWEAVE_BASE_URL,
    catalogModels: COREWEAVE_MODEL_CATALOG.map(buildCoreweaveModelDefinition),
    aliases: [{ modelRef: COREWEAVE_DEFAULT_MODEL_REF, alias: "Kimi K2.6" }],
  }),
});

export function applyCoreweaveConfig(cfg: OpenClawConfig): OpenClawConfig {
  return coreweavePresetAppliers.applyConfig(cfg);
}
