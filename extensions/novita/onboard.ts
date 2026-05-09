import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  NOVITA_BASE_URL,
  NOVITA_DEFAULT_MODEL_REF,
  NOVITA_MODEL_CATALOG,
  buildNovitaModelDefinition,
} from "./models.js";

export { NOVITA_DEFAULT_MODEL_REF };

const novitaPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: NOVITA_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "novita",
    api: "openai-completions",
    baseUrl: NOVITA_BASE_URL,
    catalogModels: NOVITA_MODEL_CATALOG.map(buildNovitaModelDefinition),
    aliases: [{ modelRef: NOVITA_DEFAULT_MODEL_REF, alias: "Novita AI" }],
  }),
});

export function applyNovitaConfig(cfg: OpenClawConfig): OpenClawConfig {
  return novitaPresetAppliers.applyConfig(cfg);
}
