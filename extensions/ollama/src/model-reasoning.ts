// Ollama plugin module owns model-specific native thinking contracts.
import type { Model, ModelThinkingLevel } from "openclaw/plugin-sdk/llm";
import {
  normalizeOllamaCloudModelId,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
} from "./defaults.js";

const OLLAMA_THINKING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OllamaThinkValue = boolean | (typeof OLLAMA_THINKING_EFFORTS)[number];
type OllamaThinkingLevelMap = Model["thinkingLevelMap"];

export function readOllamaThinkingMapValue(value: string | null | undefined) {
  return value === "false"
    ? false
    : value === "true"
      ? true
      : OLLAMA_THINKING_EFFORTS.find((effort) => effort === value);
}

/** Prepare native wire values once, inside the discovery/cache lifecycle. */
export async function buildOllamaThinkingLevelMap(
  modelId: string,
  thinking: unknown,
): Promise<OllamaThinkingLevelMap> {
  if (
    !thinking ||
    typeof thinking !== "object" ||
    !("values" in thinking) ||
    !Array.isArray(thinking.values)
  ) {
    return undefined;
  }
  const values: unknown[] = thinking.values;
  const levels: ModelThinkingLevel[] = ["off", ...OLLAMA_THINKING_EFFORTS];
  const nativeMap = Object.fromEntries(
    levels.map((level) => [
      level,
      level === "off"
        ? values.includes(false)
          ? "false"
          : null
        : values.includes(level)
          ? level
          : level === "low" && values.includes(true)
            ? "true"
            : null,
    ]),
  );
  if (!Object.values(nativeMap).some((value) => value !== null)) {
    return undefined;
  }
  // Discovery and eager provider policy must not load the streaming graph at import time.
  const { clampThinkingLevel } = await import("openclaw/plugin-sdk/llm");
  const model: Model = {
    id: modelId,
    name: modelId,
    provider: "ollama",
    api: "ollama",
    baseUrl: "",
    reasoning: true,
    input: ["text"],
    cost: OLLAMA_DEFAULT_COST,
    contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
    thinkingLevelMap: nativeMap,
  };
  return {
    ...Object.fromEntries(
      levels.map((level) => [level, nativeMap[clampThinkingLevel(model, level)]]),
    ),
    // These entries also opt shared capability readers into additional controls.
    minimal: nativeMap.minimal,
    xhigh: nativeMap.xhigh,
  };
}

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
export function applyOllamaThinkingFloor(
  payload: unknown,
  model: Pick<Model, "id" | "thinkingLevelMap">,
): unknown {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("think" in payload) ||
    payload.think !== false
  ) {
    return payload;
  }
  const floor =
    readOllamaThinkingMapValue(model.thinkingLevelMap?.off) ??
    (OLLAMA_CLOUD_THINKING_FLOOR_MODEL_IDS.has(normalizeOllamaCloudModelId(model.id))
      ? "low"
      : false);
  return floor === false ? payload : { ...payload, think: floor };
}
