// Together setup module handles plugin onboarding behavior.
import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  createModelCatalogPresetAppliers,
  createProviderConnectionPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import { TOGETHER_BASE_URL, TOGETHER_MODEL_CATALOG } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const TOGETHER_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "together",
)!;

const togetherPreset = {
  primaryModelRef: TOGETHER_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "together",
    api: "openai-completions",
    baseUrl: TOGETHER_BASE_URL,
    catalogModels: () => structuredClone(TOGETHER_MODEL_CATALOG),
    aliases: [{ modelRef: TOGETHER_DEFAULT_MODEL_REF, alias: "Together AI" }],
  }),
} satisfies Parameters<typeof createProviderConnectionPresetAppliers<[]>>[0];

export const { applyConfig: applyTogetherConfig } =
  createModelCatalogPresetAppliers(togetherPreset);
export const { applyConfig: applyTogetherConnectionConfig } =
  createProviderConnectionPresetAppliers(togetherPreset);
