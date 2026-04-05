import {
  createModelCatalogPresetAppliers,
  type MullusiConfig,
} from "mullusi/plugin-sdk/provider-onboard";
import { buildTogetherModelDefinition, TOGETHER_BASE_URL, TOGETHER_MODEL_CATALOG } from "./api.js";

export const TOGETHER_DEFAULT_MODEL_REF = "together/moonshotai/Kimi-K2.5";

const togetherPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: TOGETHER_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: MullusiConfig) => ({
    providerId: "together",
    api: "openai-completions",
    baseUrl: TOGETHER_BASE_URL,
    catalogModels: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition),
    aliases: [{ modelRef: TOGETHER_DEFAULT_MODEL_REF, alias: "Together AI" }],
  }),
});

export function applyTogetherProviderConfig(cfg: MullusiConfig): MullusiConfig {
  return togetherPresetAppliers.applyProviderConfig(cfg);
}

export function applyTogetherConfig(cfg: MullusiConfig): MullusiConfig {
  return togetherPresetAppliers.applyConfig(cfg);
}
