// Ollama plugin module owns model-specific native thinking contracts.
import { normalizeOllamaCloudModelId } from "./defaults.js";

export function supportsOllamaCloudFullThinkingEffort(modelId: string): boolean {
  // These hosted families accept low, medium, high, and max even when
  // lightweight catalog projections omit their reasoning metadata.
  const normalized = normalizeOllamaCloudModelId(modelId);
  return normalized === "glm-5.2" || /^deepseek-v4-(?:flash|pro)$/.test(normalized);
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
