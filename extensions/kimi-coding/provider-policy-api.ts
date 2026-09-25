// Kimi Code policy module exposes model-specific thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

export const KIMI_K3_MODEL_IDS = ["k3", "k3-256k"] as const;
const KIMI_K3_LEGACY_MODEL_IDS = ["k3[1m]"] as const;

// K2.8 Preview rolled out to the unchanged `kimi-for-coding` model id and
// officially supports low/high/max effort with a max default. The legacy
// aliases normalize to `kimi-for-coding` in the manifest, so they share it.
export const KIMI_CODING_THINKING_MODEL_IDS = [
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
] as const;
const KIMI_CODING_THINKING_LEGACY_MODEL_IDS = ["kimi-code", "k2p5"] as const;
const KIMI_CODING_THINKING_MODEL_ID_SET = new Set<string>([
  ...KIMI_CODING_THINKING_MODEL_IDS,
  ...KIMI_CODING_THINKING_LEGACY_MODEL_IDS,
]);

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

const KIMI_CODING_THINKING_LEVELS = [
  { id: "off" },
  { id: "low" },
  { id: "high" },
  { id: "max" },
] as const satisfies ProviderThinkingProfile["levels"];

export function isKimiK3ModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return (
    KIMI_K3_MODEL_IDS.includes(normalized as (typeof KIMI_K3_MODEL_IDS)[number]) ||
    KIMI_K3_LEGACY_MODEL_IDS.includes(normalized as (typeof KIMI_K3_LEGACY_MODEL_IDS)[number])
  );
}

export function isKimiCodingThinkingModelId(modelId: string): boolean {
  return KIMI_CODING_THINKING_MODEL_ID_SET.has(modelId.trim().toLowerCase());
}

export function resolveThinkingProfile({
  modelId,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile {
  if (isKimiK3ModelId(modelId)) {
    return {
      levels: KIMI_K3_THINKING_LEVELS,
      defaultLevel: "high",
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (isKimiCodingThinkingModelId(modelId)) {
    return {
      levels: KIMI_CODING_THINKING_LEVELS,
      defaultLevel: "max",
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
