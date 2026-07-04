import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const V4_THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function buildV4ThinkingLevel(id: (typeof V4_THINKING_LEVEL_IDS)[number]) {
  return { id };
}

const OPENCODE_GO_DEEPSEEK_V4_THINKING_PROFILE = {
  levels: V4_THINKING_LEVEL_IDS.map(buildV4ThinkingLevel),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

function isOpencodeGoDeepSeekV4ModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id === "deepseek-v4-pro" || id === "deepseek-v4-flash";
}

export function resolveOpencodeGoDeepSeekV4ThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return isOpencodeGoDeepSeekV4ModelId(modelId)
    ? OPENCODE_GO_DEEPSEEK_V4_THINKING_PROFILE
    : undefined;
}
