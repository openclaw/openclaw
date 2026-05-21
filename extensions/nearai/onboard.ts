import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildNearAIModelDefinition,
  NEARAI_BASE_URL,
  NEARAI_DEFAULT_MODEL_REF,
  NEARAI_MODEL_CATALOG,
} from "./api.js";

export { NEARAI_DEFAULT_MODEL_REF };

const nearAIPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: NEARAI_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "nearai",
    api: "openai-completions",
    baseUrl: NEARAI_BASE_URL,
    catalogModels: NEARAI_MODEL_CATALOG.map(buildNearAIModelDefinition),
    aliases: [{ modelRef: NEARAI_DEFAULT_MODEL_REF, alias: "NEAR AI GLM 5.1" }],
  }),
});

export function applyNearAIConfig(cfg: OpenClawConfig): OpenClawConfig {
  return nearAIPresetAppliers.applyConfig(cfg);
}
