// Llmrouter setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  LLMROUTER_BASE_URL,
  LLMROUTER_DEFAULT_MODEL_REF,
  LLMROUTER_MODEL_CATALOG,
} from "./models.js";

const llmrouterPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: LLMROUTER_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "llmrouter",
    api: "openai-completions" as const,
    baseUrl: LLMROUTER_BASE_URL,
    catalogModels: LLMROUTER_MODEL_CATALOG,
    aliases: [{ modelRef: LLMROUTER_DEFAULT_MODEL_REF, alias: "LLMRouter" }],
  }),
});

/** Applies LLMRouter's provider catalog, alias, and default model. */
export function applyLlmrouterConfig(cfg: OpenClawConfig): OpenClawConfig {
  return llmrouterPresetAppliers.applyConfig(cfg);
}
