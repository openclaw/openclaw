import {
  createDefaultModelsPresetAppliers,
  type MullusiConfig,
} from "mullusi/plugin-sdk/provider-onboard";
import { XAI_BASE_URL, XAI_DEFAULT_MODEL_ID } from "./model-definitions.js";
import { buildXaiCatalogModels } from "./model-definitions.js";

export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;

const xaiPresetAppliers = createDefaultModelsPresetAppliers<
  ["openai-completions" | "openai-responses"]
>({
  primaryModelRef: XAI_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: MullusiConfig, api) => ({
    providerId: "xai",
    api,
    baseUrl: XAI_BASE_URL,
    defaultModels: buildXaiCatalogModels(),
    defaultModelId: XAI_DEFAULT_MODEL_ID,
    aliases: [{ modelRef: XAI_DEFAULT_MODEL_REF, alias: "Grok" }],
  }),
});

export function applyXaiProviderConfig(cfg: MullusiConfig): MullusiConfig {
  return xaiPresetAppliers.applyProviderConfig(cfg, "openai-responses");
}

export function applyXaiResponsesApiConfig(cfg: MullusiConfig): MullusiConfig {
  return xaiPresetAppliers.applyProviderConfig(cfg, "openai-responses");
}

export function applyXaiConfig(cfg: MullusiConfig): MullusiConfig {
  return xaiPresetAppliers.applyConfig(cfg, "openai-responses");
}
