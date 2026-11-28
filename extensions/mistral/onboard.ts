import {
  createDefaultModelsPresetAppliers,
  createDefaultModelsConnectionPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
  MISTRAL_DEFAULT_MODEL_REF,
} from "./model-definitions.js";

const mistralPreset = {
  primaryModelRef: MISTRAL_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "mistral",
    api: "openai-completions",
    baseUrl: MISTRAL_BASE_URL,
    defaultModels: () => [buildMistralModelDefinition()],
    defaultModelId: MISTRAL_DEFAULT_MODEL_ID,
    aliases: [{ modelRef: MISTRAL_DEFAULT_MODEL_REF, alias: "Mistral" }],
  }),
} satisfies Parameters<typeof createDefaultModelsConnectionPresetAppliers<[]>>[0];

export const { applyConfig: applyMistralConfig, applyProviderConfig: applyMistralProviderConfig } =
  createDefaultModelsPresetAppliers(mistralPreset);
export const { applyConfig: applyMistralConnectionConfig } =
  createDefaultModelsConnectionPresetAppliers(mistralPreset);
