// Kimi Code policy module exposes model-specific thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

export const KIMI_K3_MODEL_IDS = ["k3", "k3-256k", "kimi-k3"] as const;
const KIMI_K3_LEGACY_MODEL_IDS = ["k3[1m]"] as const;
// Kimi Code's K2.8 backend leaks reasoning into visible text when thinking is disabled.
const KIMI_CODE_ENABLED_ONLY_MODEL_IDS = [
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  // Legacy aliases of kimi-for-coding.
  "kimi-code",
  "k2p5",
] as const;

export const KIMI_K3_THINKING_EFFORTS = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

const KIMI_K3_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "adaptive" },
  { id: "xhigh" },
  { id: "max" },
] as const satisfies ProviderThinkingProfile["levels"];

export function isKimiK3ModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return (
    KIMI_K3_MODEL_IDS.includes(normalized as (typeof KIMI_K3_MODEL_IDS)[number]) ||
    KIMI_K3_LEGACY_MODEL_IDS.includes(normalized as (typeof KIMI_K3_LEGACY_MODEL_IDS)[number])
  );
}

/** Kimi Code K2 models whose backend cannot honor disabled thinking without leaking reasoning. */
export function isKimiCodeEnabledOnlyModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return KIMI_CODE_ENABLED_ONLY_MODEL_IDS.some((id) => id === normalized);
}

export function resolveThinkingProfile({
  modelId,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile {
  if (isKimiK3ModelId(modelId)) {
    return {
      levels: KIMI_K3_THINKING_LEVELS,
      defaultLevel: modelId.trim().toLowerCase() === "kimi-k3" ? "off" : "high",
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (isKimiCodeEnabledOnlyModelId(modelId)) {
    return { levels: [{ id: "low", label: "on" }], defaultLevel: "low" };
  }
  return {
    levels: [
      { id: "off", label: "off" },
      { id: "low", label: "on" },
    ],
    defaultLevel: "off",
  };
}
