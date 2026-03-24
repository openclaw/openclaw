import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildPlamoCatalogModels,
  PLAMO_BASE_URL,
  PLAMO_DEFAULT_MODEL_REF,
} from "./model-definitions.js";

export { PLAMO_DEFAULT_MODEL_REF };

const PLAMO_DEFAULT_ACP_BACKEND = "acpx";

const plamoPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: PLAMO_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "plamo",
    api: "openai-completions",
    baseUrl: PLAMO_BASE_URL,
    catalogModels: buildPlamoCatalogModels(),
    aliases: [{ modelRef: PLAMO_DEFAULT_MODEL_REF, alias: "PLaMo" }],
  }),
});

export function applyPlamoProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return plamoPresetAppliers.applyProviderConfig(cfg);
}

export function applyPlamoConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = plamoPresetAppliers.applyConfig(cfg);
  if (next.acp?.backend || next.plugins?.entries?.acpx?.enabled === false) {
    return next;
  }
  return {
    ...next,
    acp: {
      ...next.acp,
      backend: PLAMO_DEFAULT_ACP_BACKEND,
    },
  };
}
