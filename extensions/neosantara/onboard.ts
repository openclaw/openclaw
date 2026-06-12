// Neosantara setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildNeosantaraModelDefinition,
  NEOSANTARA_BASE_URL,
  NEOSANTARA_MODEL_CATALOG,
} from "./models.js";

export const NEOSANTARA_DEFAULT_MODEL_REF = "neosantara/grok-4.1-fast-non-reasoning";

const neosantaraPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: NEOSANTARA_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "neosantara",
    api: "openai-completions",
    baseUrl: NEOSANTARA_BASE_URL,
    catalogModels: NEOSANTARA_MODEL_CATALOG.map(buildNeosantaraModelDefinition),
    aliases: [{ modelRef: NEOSANTARA_DEFAULT_MODEL_REF, alias: "Neosantara" }],
  }),
});

export function applyNeosantaraConfig(cfg: OpenClawConfig): OpenClawConfig {
  return neosantaraPresetAppliers.applyConfig(cfg);
}
