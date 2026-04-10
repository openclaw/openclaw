import { AIMLAPI_DEFAULT_MODEL_REF } from "./runtime-api.js";
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  AIMLAPI_BASE_URL,
  buildAimlapiStaticCatalog,
} from "./runtime-api.js";

export { AIMLAPI_DEFAULT_MODEL_REF };

const aimlapiPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: AIMLAPI_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "aimlapi",
    api: "openai-completions" as const,
    baseUrl: AIMLAPI_BASE_URL,
    catalogModels: buildAimlapiStaticCatalog(),
    aliases: [{ modelRef: AIMLAPI_DEFAULT_MODEL_REF, alias: "AI/ML API" }],
  }),
});

export function applyAimlapiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return aimlapiPresetAppliers.applyProviderConfig(cfg);
}

export function applyAimlapiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return aimlapiPresetAppliers.applyConfig(cfg);
}
