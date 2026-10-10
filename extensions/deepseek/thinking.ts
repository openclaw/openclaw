import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { isDeepSeekV4ModelId } from "./models.js";

const DEEPSEEK_V4_THINKING_PROFILE = {
  levels: (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((id) => ({
    id,
  })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveDeepSeekV4ThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return isDeepSeekV4ModelId(modelId) ? DEEPSEEK_V4_THINKING_PROFILE : undefined;
}
