import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildCerebrasCatalogModels, CEREBRAS_BASE_URL } from "./provider-catalog.js";

export const CEREBRAS_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "cerebras",
)!;

export const { applyConfig: applyCerebrasConfig } = createProviderConnectionPresetAppliers<[]>({
  primaryModelRef: CEREBRAS_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "cerebras",
    api: "openai-completions",
    baseUrl: CEREBRAS_BASE_URL,
    catalogModels: buildCerebrasCatalogModels,
    aliases: [{ modelRef: CEREBRAS_DEFAULT_MODEL_REF, alias: "Cerebras Gemma 4 31B" }],
  }),
});
