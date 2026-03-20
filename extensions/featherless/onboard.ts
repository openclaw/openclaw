import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildFeatherlessModelDefinition,
  FEATHERLESS_BASE_URL,
  FEATHERLESS_MODEL_CATALOG,
} from "./models.js";

export const FEATHERLESS_DEFAULT_MODEL_REF = "featherless/MiniMaxAI/MiniMax-M2.5";

const featherlessPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: FEATHERLESS_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "featherless",
    api: "openai-completions",
    baseUrl: FEATHERLESS_BASE_URL,
    catalogModels: FEATHERLESS_MODEL_CATALOG.map(buildFeatherlessModelDefinition),
    aliases: [{ modelRef: FEATHERLESS_DEFAULT_MODEL_REF, alias: "Featherless AI" }],
  }),
});

export function applyFeatherlessProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return featherlessPresetAppliers.applyProviderConfig(cfg);
}

export function applyFeatherlessConfig(cfg: OpenClawConfig): OpenClawConfig {
  return featherlessPresetAppliers.applyConfig(cfg);
}
