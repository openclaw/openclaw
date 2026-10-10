import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  createModelCatalogPresetAppliers,
  createProviderConnectionPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildMetaCatalogModels, META_BASE_URL } from "./provider-catalog.js";

export const META_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "meta")!;

const metaPreset = {
  primaryModelRef: META_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "meta",
    api: "openai-responses",
    baseUrl: META_BASE_URL,
    catalogModels: buildMetaCatalogModels,
    aliases: [{ modelRef: META_DEFAULT_MODEL_REF, alias: "Muse Spark 1.3" }],
  }),
} satisfies Parameters<typeof createProviderConnectionPresetAppliers<[]>>[0];

export const { applyConfig: applyMetaConfig } = createModelCatalogPresetAppliers(metaPreset);
export const { applyConfig: applyMetaConnectionConfig } =
  createProviderConnectionPresetAppliers(metaPreset);
