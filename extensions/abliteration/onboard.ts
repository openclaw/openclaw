import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  ABLITERATION_BASE_URL,
  ABLITERATION_DEFAULT_MODEL_REF,
  ABLITERATION_MODEL_CATALOG,
  buildAbliterationModelDefinition,
} from "./models.js";

export { ABLITERATION_DEFAULT_MODEL_REF };

const abliterationPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: ABLITERATION_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "abliteration",
    api: "anthropic-messages",
    baseUrl: ABLITERATION_BASE_URL,
    catalogModels: ABLITERATION_MODEL_CATALOG.map(buildAbliterationModelDefinition),
  }),
});

export function applyAbliterationProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return abliterationPresetAppliers.applyProviderConfig(cfg);
}

export function applyAbliterationConfig(cfg: OpenClawConfig): OpenClawConfig {
  return abliterationPresetAppliers.applyConfig(cfg);
}
