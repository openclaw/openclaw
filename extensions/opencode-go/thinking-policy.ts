import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const DEEPSEEK_V4_MODEL_IDS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

function isDeepSeekV4ModelId(modelId: string): boolean {
  return DEEPSEEK_V4_MODEL_IDS.has(modelId);
}

const OPCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function buildThinkingLevel(id: (typeof OPCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_IDS)[number]) {
  return { id };
}

const OPCODE_GO_DEEPSEEK_V4_THINKING_PROFILE: ProviderThinkingProfile = {
  levels: OPCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_IDS.map(buildThinkingLevel),
  defaultLevel: "high",
};

export function supportsOpencodeGoDeepSeekV4XHighThinking(modelId: string): boolean {
  return isDeepSeekV4ModelId(modelId);
}

export function resolveOpencodeGoDeepSeekV4ThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return isDeepSeekV4ModelId(modelId)
    ? OPCODE_GO_DEEPSEEK_V4_THINKING_PROFILE
    : undefined;
}
