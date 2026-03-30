import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildUpstageModelDefinition,
  UPSTAGE_BASE_URL,
  UPSTAGE_DEFAULT_MODEL_REF,
  UPSTAGE_MODEL_CATALOG,
} from "./models.js";

export { UPSTAGE_DEFAULT_MODEL_REF };

const upstagePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: UPSTAGE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "upstage",
    api: "openai-completions",
    baseUrl: UPSTAGE_BASE_URL,
    catalogModels: UPSTAGE_MODEL_CATALOG.map(buildUpstageModelDefinition),
    aliases: [{ modelRef: UPSTAGE_DEFAULT_MODEL_REF, alias: "Upstage" }],
  }),
});

export function applyUpstageProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return upstagePresetAppliers.applyProviderConfig(cfg);
}

export function applyUpstageConfig(cfg: OpenClawConfig): OpenClawConfig {
  return upstagePresetAppliers.applyConfig(cfg);
}
