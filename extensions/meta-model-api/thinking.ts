// Meta Model API plugin module implements thinking behavior.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const META_MODEL_API_REASONING_MODEL_IDS = new Set(["muse-spark", "muse-spark-1.1"]);

function isMetaModelApiReasoningModelId(modelId: string): boolean {
  return META_MODEL_API_REASONING_MODEL_IDS.has(modelId.toLowerCase());
}

const META_THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const META_THINKING_PROFILE = {
  levels: META_THINKING_LEVEL_IDS.map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveMetaModelApiThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return isMetaModelApiReasoningModelId(modelId) ? META_THINKING_PROFILE : undefined;
}
