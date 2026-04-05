import {
  createDefaultModelsPresetAppliers,
  type MullusiConfig,
} from "mullusi/plugin-sdk/provider-onboard";
import { buildXiaomiProvider, XIAOMI_DEFAULT_MODEL_ID } from "./provider-catalog.js";

export const XIAOMI_DEFAULT_MODEL_REF = `xiaomi/${XIAOMI_DEFAULT_MODEL_ID}`;

const xiaomiPresetAppliers = createDefaultModelsPresetAppliers({
  primaryModelRef: XIAOMI_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: MullusiConfig) => {
    const defaultProvider = buildXiaomiProvider();
    return {
      providerId: "xiaomi",
      api: defaultProvider.api ?? "openai-completions",
      baseUrl: defaultProvider.baseUrl,
      defaultModels: defaultProvider.models ?? [],
      defaultModelId: XIAOMI_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: XIAOMI_DEFAULT_MODEL_REF, alias: "Xiaomi" }],
    };
  },
});

export function applyXiaomiProviderConfig(cfg: MullusiConfig): MullusiConfig {
  return xiaomiPresetAppliers.applyProviderConfig(cfg);
}

export function applyXiaomiConfig(cfg: MullusiConfig): MullusiConfig {
  return xiaomiPresetAppliers.applyConfig(cfg);
}
