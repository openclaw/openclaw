// LongCat setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  createProviderConnectionPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import { LONGCAT_BASE_URL, LONGCAT_DEFAULT_MODEL_REF, LONGCAT_MODEL_CATALOG } from "./models.js";

const longCatPreset = {
  primaryModelRef: LONGCAT_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "longcat",
    api: "openai-completions",
    baseUrl: LONGCAT_BASE_URL,
    catalogModels: () => LONGCAT_MODEL_CATALOG,
    aliases: [{ modelRef: LONGCAT_DEFAULT_MODEL_REF, alias: "LongCat 2.0" }],
  }),
} satisfies Parameters<typeof createProviderConnectionPresetAppliers<[]>>[0];

export const { applyConfig: applyLongCatConfig } = createModelCatalogPresetAppliers(longCatPreset);
export const { applyConfig: applyLongCatConnectionConfig } =
  createProviderConnectionPresetAppliers(longCatPreset);
