/** Telnyx onboarding config helpers. */
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildStaticTelnyxModels, TELNYX_BASE_URL, TELNYX_DEFAULT_MODEL_REF } from "./models.js";

const telnyxPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: TELNYX_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "telnyx",
    api: "openai-completions",
    baseUrl: TELNYX_BASE_URL,
    catalogModels: buildStaticTelnyxModels(),
  }),
});

/** Applies Telnyx's provider catalog and default model. */
export function applyTelnyxConfig(cfg: OpenClawConfig): OpenClawConfig {
  return telnyxPresetAppliers.applyConfig(cfg);
}
