import {
  createModelCatalogPresetAppliers,
  createProviderConnectionPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import { ARCEE_BASE_URL } from "./models.js";
import {
  buildArceeCatalogModels,
  buildArceeOpenRouterCatalogModels,
  OPENROUTER_BASE_URL,
} from "./provider-catalog.js";

export const ARCEE_DEFAULT_MODEL_REF = "arcee/trinity-large-thinking";
export const ARCEE_OPENROUTER_DEFAULT_MODEL_REF = "arcee/trinity-large-thinking";

const ARCEE_PRESET = {
  primaryModelRef: ARCEE_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "arcee",
    api: "openai-completions" as const,
    baseUrl: ARCEE_BASE_URL,
    catalogModels: buildArceeCatalogModels,
    aliases: [{ modelRef: ARCEE_DEFAULT_MODEL_REF, alias: "Arcee AI" }],
  }),
};

const ARCEE_OPENROUTER_PRESET = {
  primaryModelRef: ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "arcee",
    api: "openai-completions" as const,
    baseUrl: OPENROUTER_BASE_URL,
    catalogModels: buildArceeOpenRouterCatalogModels,
    aliases: [{ modelRef: ARCEE_OPENROUTER_DEFAULT_MODEL_REF, alias: "Arcee AI (OpenRouter)" }],
  }),
};

export const { applyConfig: applyArceeConfig } = createModelCatalogPresetAppliers(ARCEE_PRESET);
export const { applyConfig: applyArceeOpenRouterConfig } =
  createModelCatalogPresetAppliers(ARCEE_OPENROUTER_PRESET);
export const { applyConfig: applyArceeOnboardConfig } =
  createProviderConnectionPresetAppliers(ARCEE_PRESET);
export const { applyConfig: applyArceeOpenRouterOnboardConfig } =
  createProviderConnectionPresetAppliers(ARCEE_OPENROUTER_PRESET);
