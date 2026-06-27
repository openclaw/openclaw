/**
 * TrustedRouter onboarding config helpers.
 */
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildTrustedRouterModelDefinition,
  TRUSTEDROUTER_BASE_URL,
  TRUSTEDROUTER_MODEL_CATALOG,
} from "./models.js";

/** Default TrustedRouter model reference used after onboarding. */
export const TRUSTEDROUTER_DEFAULT_MODEL_REF = "trustedrouter/auto";

const trustedRouterPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: TRUSTEDROUTER_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "trustedrouter",
    api: "openai-completions",
    baseUrl: TRUSTEDROUTER_BASE_URL,
    catalogModels: TRUSTEDROUTER_MODEL_CATALOG.map(buildTrustedRouterModelDefinition),
    aliases: [{ modelRef: TRUSTEDROUTER_DEFAULT_MODEL_REF, alias: "TrustedRouter Auto" }],
  }),
});

/** Applies TrustedRouter provider/catalog config and default model aliases. */
export function applyTrustedRouterConfig(cfg: OpenClawConfig): OpenClawConfig {
  return trustedRouterPresetAppliers.applyConfig(cfg);
}
