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

// Verified 2026-10-01 against the `thinking.values` that `/api/show` reports: these
// hosted models list no `false`, so `think: false` cannot turn their thinking off and
// returns the reasoning inside the answer. `low` is their lowest advertised level.
const OLLAMA_CLOUD_THINKING_FLOOR_MODEL_IDS = new Set(["glm-5.3", "glm-5.3-flash"]);

// The native transport applies this to the final request body, after payload hooks, so
// configured values, agent runtime levels, and one-shot completions all get the floor.
export function applyOllamaThinkingFloor(payload: unknown, modelId: string): unknown {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("think" in payload) ||
    payload.think !== false ||
    !OLLAMA_CLOUD_THINKING_FLOOR_MODEL_IDS.has(normalizeOllamaCloudModelId(modelId))
  ) {
    return payload;
  }
  return { ...payload, think: "low" };
}
