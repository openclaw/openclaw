import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/plugin-entry";

export const MISTRAL_SMALL_LATEST_ID = "mistral-small-latest";
export const MISTRAL_SMALL_4_ID = "mistral-small-2603";
export const MISTRAL_MEDIUM_3_5_ID = "mistral-medium-3-5";

const MISTRAL_REASONING_MODEL_IDS = new Set([
  MISTRAL_SMALL_LATEST_ID,
  MISTRAL_SMALL_4_ID,
  MISTRAL_MEDIUM_3_5_ID,
]);

const MISTRAL_THINKING_LEVELS = [
  ["off", "none"],
  ["minimal", "none"],
  ["low", "high"],
  ["medium", "high"],
  ["high", "high"],
  ["xhigh", "high"],
  ["adaptive", "high"],
  ["max", "high"],
] as const;
const MISTRAL_REASONING_EFFORT_MAP = Object.fromEntries(MISTRAL_THINKING_LEVELS);

export function resolveMistralReasoningEffortMap(
  modelId: string | undefined,
): Record<string, string> | undefined {
  return modelId !== undefined && MISTRAL_REASONING_MODEL_IDS.has(modelId)
    ? MISTRAL_REASONING_EFFORT_MAP
    : undefined;
}

export function resolveThinkingProfile({ modelId }: ProviderDefaultThinkingPolicyContext) {
  return resolveMistralReasoningEffortMap(modelId)
    ? {
        levels: MISTRAL_THINKING_LEVELS.map(([id]) => ({ id })),
        defaultLevel: "off" as const,
      }
    : undefined;
}
