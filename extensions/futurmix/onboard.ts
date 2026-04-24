import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildFuturMixModelDefinition,
  FUTURMIX_BASE_URL,
  FUTURMIX_MODEL_CATALOG,
} from "./models.js";

export const FUTURMIX_DEFAULT_MODEL_REF = "futurmix/claude-sonnet-4-6";

const futurmixPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: FUTURMIX_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "futurmix",
    api: "openai-completions",
    baseUrl: FUTURMIX_BASE_URL,
    catalogModels: FUTURMIX_MODEL_CATALOG.map(buildFuturMixModelDefinition),
    aliases: [{ modelRef: FUTURMIX_DEFAULT_MODEL_REF, alias: "FuturMix" }],
  }),
});

export function applyFuturMixConfig(cfg: OpenClawConfig): OpenClawConfig {
  return futurmixPresetAppliers.applyConfig(cfg);
}
