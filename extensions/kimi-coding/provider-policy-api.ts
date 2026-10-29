// Kimi Code policy module exposes model-specific thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

// K3.1 Pro shares K3's efforts and adaptive request shape, but Kimi Code rejects disabled thinking.
const KIMI_K3_1_MODEL_IDS = ["k3.1-pro", "k3.1-pro-highspeed"] as const;
export const KIMI_K3_MODEL_IDS = ["k3", "k3-256k", "kimi-k3", ...KIMI_K3_1_MODEL_IDS] as const;
const KIMI_K3_LEGACY_MODEL_IDS = ["k3[1m]"] as const;

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

/** Kimi Code K3.1 Pro models, whose backend rejects disabled thinking. */
export function isKimiK31ModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return KIMI_K3_1_MODEL_IDS.some((id) => id === normalized);
}

export function resolveThinkingProfile({
  modelId,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile {
  if (isKimiK3ModelId(modelId)) {
    return {
      levels: isKimiK31ModelId(modelId)
        ? KIMI_K3_THINKING_LEVELS.filter(({ id }) => id !== "off")
        : KIMI_K3_THINKING_LEVELS,
      defaultLevel: modelId.trim().toLowerCase() === "kimi-k3" ? "off" : "high",
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  return {
    levels: [
      { id: "off", label: "off" },
      { id: "low", label: "on" },
    ],
    defaultLevel: "off",
  };
}
