/**
 * AIOnly onboarding config helpers.
 */
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildAIOnlyModelDefinition, AIONLY_BASE_URL, AIONLY_MODEL_CATALOG } from "./models.js";

/** Default AIOnly model reference used after onboarding. */
export const AIONLY_DEFAULT_MODEL_REF = "aionly/deepseek-v4-flash";

const aionlyPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: AIONLY_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "aionly",
    api: "openai-completions",
    baseUrl: AIONLY_BASE_URL,
    catalogModels: AIONLY_MODEL_CATALOG.map(buildAIOnlyModelDefinition),
    aliases: [{ modelRef: AIONLY_DEFAULT_MODEL_REF, alias: "AIOnly DeepSeek V4 Flash" }],
  }),
});

/** Applies AIOnly provider/catalog config and default model aliases. */
export function applyAIOnlyConfig(cfg: OpenClawConfig): OpenClawConfig {
  return aionlyPresetAppliers.applyConfig(cfg);
}
