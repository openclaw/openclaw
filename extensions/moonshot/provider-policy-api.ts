// Moonshot policy module exposes model-specific thinking controls before runtime registration.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";

export const KIMI_K2_7_CODE_MODEL_ID = "kimi-k2.7-code";
export const KIMI_K2_7_CODE_HIGHSPEED_MODEL_ID = "kimi-k2.7-code-highspeed";
// K3.1 Pro shares K3's API contract: always-on thinking, reasoning_effort and native video.
const KIMI_K3_MODEL_IDS: readonly string[] = [
  "kimi-k3",
  "kimi-k3.1-pro",
  "kimi-k3.1-pro-highspeed",
];
const ALWAYS_THINKING_PROFILES: Readonly<Record<string, { id: "low" | "max"; label: string }>> = {
  ...Object.fromEntries(KIMI_K3_MODEL_IDS.map((id) => [id, { id: "max", label: "max" }])),
  [KIMI_K2_7_CODE_MODEL_ID]: { id: "low", label: "on" },
  [KIMI_K2_7_CODE_HIGHSPEED_MODEL_ID]: { id: "low", label: "on" },
};

export function isNativeMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  return [MOONSHOT_BASE_URL, MOONSHOT_CN_BASE_URL].some(
    (official) => baseUrl === official || baseUrl === `${official}/`,
  );
}

export function isMoonshotK3NativeVideoRoute(route: {
  provider?: string;
  modelId?: string;
  api?: string;
  baseUrl?: string;
}): boolean {
  return (
    route.provider === "moonshot" &&
    KIMI_K3_MODEL_IDS.includes(route.modelId ?? "") &&
    route.api === "openai-completions" &&
    isNativeMoonshotBaseUrl(route.baseUrl)
  );
}

export function isMoonshotAlwaysThinkingModelId(modelId: string): boolean {
  return Object.hasOwn(ALWAYS_THINKING_PROFILES, modelId.trim().toLowerCase());
}

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  const modelId = context.modelId.trim().toLowerCase();
  const profile = Object.hasOwn(ALWAYS_THINKING_PROFILES, modelId)
    ? ALWAYS_THINKING_PROFILES[modelId]
    : undefined;
  if (profile) {
    return {
      levels: [profile],
      defaultLevel: profile.id,
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
