import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { OCI_GENAI_MODELS, type OciGenAIModelEntry } from "./models.js";
import { buildOciCatalogModels } from "./provider-catalog.js";
import { buildOciGenAIOpenAIBaseUrl, DEFAULT_OCI_GENAI_REGION } from "./regions.js";

export const OCI_DEFAULT_MODEL_ID = "meta.llama-3.3-70b-instruct";
export const OCI_DEFAULT_MODEL_REF = `oci/${OCI_DEFAULT_MODEL_ID}`;

const OCI_BASE_URL = buildOciGenAIOpenAIBaseUrl(DEFAULT_OCI_GENAI_REGION);

function modelEntryToDefinition(entry: OciGenAIModelEntry): ModelDefinitionConfig {
  const catalog = buildOciCatalogModels();
  const match = catalog.find((m) => m.id === entry.id);
  if (!match) {
    throw new Error(`OCI model entry ${entry.id} missing from catalog`);
  }
  return match;
}

const ociPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: OCI_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "oci",
    api: "openai-completions" as const,
    baseUrl: OCI_BASE_URL,
    catalogModels: OCI_GENAI_MODELS.map(modelEntryToDefinition),
    aliases: [{ modelRef: OCI_DEFAULT_MODEL_REF, alias: "OCI Llama 3.3 70B" }],
  }),
});

export function applyOciConfig(cfg: OpenClawConfig): OpenClawConfig {
  return ociPresetAppliers.applyConfig(cfg);
}
