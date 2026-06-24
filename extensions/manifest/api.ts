/**
 * Public Manifest provider plugin API exports.
 */
export {
  buildManifestModelDefinition,
  MANIFEST_BASE_URL,
  MANIFEST_MODEL_CATALOG,
} from "./models.js";
export { buildManifestProvider } from "./provider-catalog.js";
export { applyManifestConfig, MANIFEST_DEFAULT_MODEL_REF } from "./onboard.js";
