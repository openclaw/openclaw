// Kimi Code policy module exposes model-specific thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const MODELS = manifest.modelCatalog.providers.kimi.models;
// Rows that list reasoning efforts use the K3 request shape. Self-hosted K3 serves `kimi-k3`
// without a Kimi Code row, and retired `k3[1m]` still names K3 in shipped configs.
const KIMI_K3_MODEL_IDS = new Set([
  ...MODELS.flatMap((row) => (row.compat?.supportedReasoningEfforts ? [row.id] : [])),
  "kimi-k3",
  "k3[1m]",
]);
// Rows that map `off` to null cannot disable thinking. Kimi Code's K2.8 backend leaks reasoning
// when thinking is disabled, but released readers still offer `off` for it, so its IDs stay here.
const KIMI_CODE_ENABLED_ONLY_MODEL_IDS = new Set([
  ...MODELS.flatMap((row) =>
    row.thinkingLevelMap && "off" in row.thinkingLevelMap && row.thinkingLevelMap.off === null
      ? [row.id]
      : [],
  ),
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  // Legacy aliases of kimi-for-coding.
  "kimi-code",
  "k2p5",
]);

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
  return KIMI_K3_MODEL_IDS.has(modelId.trim().toLowerCase());
}

/** Kimi Code models whose backend cannot honor disabled thinking. */
export function isKimiCodeEnabledOnlyModelId(modelId: string): boolean {
  return KIMI_CODE_ENABLED_ONLY_MODEL_IDS.has(modelId.trim().toLowerCase());
}

export function resolveThinkingProfile({
  modelId,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile {
  if (isKimiK3ModelId(modelId)) {
    return {
      levels: isKimiCodeEnabledOnlyModelId(modelId)
        ? KIMI_K3_THINKING_LEVELS.filter(({ id }) => id !== "off")
        : KIMI_K3_THINKING_LEVELS,
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
