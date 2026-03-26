import {
  buildDinferenceModelDefinition,
  DINFERENCE_BASE_URL,
  DINFERENCE_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const DINFERENCE_DEFAULT_MODEL_ID = "glm-5";
export const DINFERENCE_DEFAULT_MODEL_REF = `dinference/${DINFERENCE_DEFAULT_MODEL_ID}`;

const dinferencePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: DINFERENCE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "dinference",
    api: "openai-completions",
    baseUrl: DINFERENCE_BASE_URL,
    catalogModels: DINFERENCE_MODEL_CATALOG.map(buildDinferenceModelDefinition),
    aliases: [{ modelRef: DINFERENCE_DEFAULT_MODEL_REF, alias: "DInference" }],
  }),
});

export function applyDinferenceProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return dinferencePresetAppliers.applyProviderConfig(cfg);
}

export function applyDinferenceConfig(cfg: OpenClawConfig): OpenClawConfig {
  return dinferencePresetAppliers.applyConfig(cfg);
}
