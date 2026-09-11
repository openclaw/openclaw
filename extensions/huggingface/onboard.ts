// Huggingface setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  createProviderConnectionPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import { HUGGINGFACE_BASE_URL, HUGGINGFACE_MODEL_CATALOG } from "./models.js";

export const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";

const huggingfacePreset = {
  primaryModelRef: HUGGINGFACE_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "huggingface",
    api: "openai-completions",
    baseUrl: HUGGINGFACE_BASE_URL,
    catalogModels: () => HUGGINGFACE_MODEL_CATALOG.map((model) => Object.assign({}, model)),
    aliases: [{ modelRef: HUGGINGFACE_DEFAULT_MODEL_REF, alias: "Hugging Face" }],
  }),
} satisfies Parameters<typeof createProviderConnectionPresetAppliers<[]>>[0];

export const { applyConfig: applyHuggingfaceConfig } =
  createModelCatalogPresetAppliers(huggingfacePreset);
export const { applyConfig: applyHuggingfaceConnectionConfig } =
  createProviderConnectionPresetAppliers(huggingfacePreset);
