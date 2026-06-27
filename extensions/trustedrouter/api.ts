/**
 * Public TrustedRouter provider plugin API exports.
 */
export {
  buildTrustedRouterModelDefinition,
  TRUSTEDROUTER_BASE_URL,
  TRUSTEDROUTER_MODEL_CATALOG,
} from "./models.js";
export { buildTrustedRouterProvider } from "./provider-catalog.js";
export { applyTrustedRouterConfig, TRUSTEDROUTER_DEFAULT_MODEL_REF } from "./onboard.js";
