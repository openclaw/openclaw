import {
  buildSambanovaModelDefinition,
  SAMBANOVA_BASE_URL,
  SAMBANOVA_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const SAMBANOVA_DEFAULT_MODEL_REF = "sambanova/MiniMax-M2.5";

const sambanovaPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: SAMBANOVA_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "sambanova",
    api: "openai-completions",
    baseUrl: SAMBANOVA_BASE_URL,
    catalogModels: SAMBANOVA_MODEL_CATALOG.map(buildSambanovaModelDefinition),
    aliases: [{ modelRef: SAMBANOVA_DEFAULT_MODEL_REF, alias: "SambaNova" }],
  }),
});

export function applySambanovaProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return sambanovaPresetAppliers.applyProviderConfig(cfg);
}

export function applySambanovaConfig(cfg: OpenClawConfig): OpenClawConfig {
  return sambanovaPresetAppliers.applyConfig(cfg);
}
