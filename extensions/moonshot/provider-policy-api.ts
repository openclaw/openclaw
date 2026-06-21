// Moonshot policy module exposes model-specific thinking controls before runtime registration.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";

export const KIMI_K2_7_CODE_MODEL_ID = "kimi-k2.7-code";

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  if (context.modelId.trim().toLowerCase() === KIMI_K2_7_CODE_MODEL_ID) {
    return {
      levels: [{ id: "low" as const, label: "on" }],
      defaultLevel: "low" as const,
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  return {
    levels: [
      { id: "off" as const, label: "off" },
      { id: "low" as const, label: "on" },
    ],
    defaultLevel: "off" as const,
  };
}
