import type { ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("sarvam-models");

export const SARVAM_BASE_URL = "https://api.sarvam.ai/v1";
export const SARVAM_DEFAULT_MODEL_ID = "sarvam-30b";
export const SARVAM_DEFAULT_MODEL_REF = `sarvam/${SARVAM_DEFAULT_MODEL_ID}`;

// Sarvam uses credit-based pricing, not per-token costs.
// Set to 0 as costs vary by usage.
export const SARVAM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const SARVAM_DEFAULT_CONTEXT_WINDOW = 128_000;
const SARVAM_DEFAULT_MAX_TOKENS = 8192;

/**
 * Complete catalog of Sarvam AI models.
 *
 * Sarvam AI provides multilingual language models optimized for Indian languages.
 * Both models use Apache 2.0 license and offer OpenAI-compatible chat completions API.
 *
 * This catalog serves as a fallback when the Sarvam API is unreachable.
 */
export const SARVAM_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "sarvam-30b",
    name: "Sarvam 30B",
    reasoning: true,
    input: ["text"],
    cost: SARVAM_DEFAULT_COST,
    contextWindow: SARVAM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: SARVAM_DEFAULT_MAX_TOKENS,
    compat: {
      supportsTools: true,
      supportsReasoningEffort: false,
    },
  },
  {
    id: "sarvam-105b",
    name: "Sarvam 105B",
    reasoning: true,
    input: ["text"],
    cost: SARVAM_DEFAULT_COST,
    contextWindow: SARVAM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: SARVAM_DEFAULT_MAX_TOKENS,
    compat: {
      supportsTools: true,
      supportsReasoningEffort: false,
    },
  },
];

/**
 * Discover Sarvam models from the API.
 * Currently returns static catalog as Sarvam API does not have a public model discovery endpoint.
 */
export async function discoverSarvamModels(): Promise<ModelDefinitionConfig[]> {
  // Skip discovery in test environments
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return SARVAM_MODEL_CATALOG;
  }

  // Return static catalog as Sarvam does not expose a /models endpoint
  log.debug("Using static Sarvam model catalog");
  return SARVAM_MODEL_CATALOG;
}
