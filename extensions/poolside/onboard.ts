/** Poolside onboarding config helpers. */
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildStaticPoolsideModels,
  POOLSIDE_BASE_URL,
  POOLSIDE_DEFAULT_MODEL_REF,
} from "./models.js";

const poolsidePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: POOLSIDE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "poolside",
    api: "openai-completions",
    baseUrl: POOLSIDE_BASE_URL,
    catalogModels: buildStaticPoolsideModels(),
    aliases: [{ modelRef: POOLSIDE_DEFAULT_MODEL_REF, alias: "Laguna S 2.1" }],
  }),
});

/** Applies Poolside's provider catalog, alias, and default model. */
export function applyPoolsideConfig(cfg: OpenClawConfig): OpenClawConfig {
  return poolsidePresetAppliers.applyConfig(cfg);
}
