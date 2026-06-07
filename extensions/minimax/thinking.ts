// MiniMax thinking policy keeps M3 active by default while preserving M2.x leak prevention.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function resolveMinimaxThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  if (/^MiniMax-M3(\b|[-.])/i.test(modelId)) {
    return {
      levels: THINKING_LEVELS.map((id) => ({ id })),
      defaultLevel: "low",
    };
  }
  if (/^MiniMax-M2(?:\b|[-.])/i.test(modelId)) {
    return {
      levels: THINKING_LEVELS.map((id) => ({ id })),
      defaultLevel: "off",
    };
  }
  return undefined;
}
