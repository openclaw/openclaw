// Public Llmrouter provider plugin API exports.
export {
  LLMROUTER_BASE_URL,
  LLMROUTER_DEFAULT_MODEL_ID,
  LLMROUTER_DEFAULT_MODEL_REF,
  LLMROUTER_MODEL_CATALOG,
  resolveLlmrouterDynamicModel,
} from "./models.js";
export { applyLlmrouterConfig } from "./onboard.js";
export { buildLlmrouterProvider } from "./provider-catalog.js";
