// Synthetic setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  createProviderConnectionPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_DEFAULT_MODEL_REF,
  SYNTHETIC_MODEL_CATALOG,
} from "./models.js";

export { SYNTHETIC_DEFAULT_MODEL_REF };

const syntheticPreset = {
  primaryModelRef: SYNTHETIC_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "synthetic",
    api: "anthropic-messages",
    baseUrl: SYNTHETIC_BASE_URL,
    catalogModels: () => SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
    aliases: [{ modelRef: SYNTHETIC_DEFAULT_MODEL_REF, alias: "MiniMax M3" }],
  }),
} satisfies Parameters<typeof createProviderConnectionPresetAppliers<[]>>[0];

export const {
  applyConfig: applySyntheticConfig,
  applyProviderConfig: applySyntheticProviderConfig,
} = createModelCatalogPresetAppliers(syntheticPreset);
export const { applyConfig: applySyntheticConnectionConfig } =
  createProviderConnectionPresetAppliers(syntheticPreset);
