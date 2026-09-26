// Ollama plugin module owns model-specific native thinking contracts.
import { normalizeOllamaCloudModelId } from "./defaults.js";

// Each id below was verified on 2026-09-22 against the `thinking` descriptor
// `/api/show` reports for that model, whose values include "max". An id joins
// this set only after that check.
const OLLAMA_CLOUD_FULL_THINKING_EFFORT_MODEL_IDS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "kimi-k3",
]);

export function supportsOllamaCloudFullThinkingEffort(modelId: string): boolean {
  // These ids accept native max, and are treated as reasoning models even when
  // lightweight catalog projections omit their reasoning metadata; lower tiers
  // and `false` follow the shared Ollama mapping.
  return OLLAMA_CLOUD_FULL_THINKING_EFFORT_MODEL_IDS.has(normalizeOllamaCloudModelId(modelId));
}
