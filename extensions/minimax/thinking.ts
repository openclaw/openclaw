// MiniMax thinking policy keeps M3 active by default while preserving M2.x leak prevention.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const BUDGET_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const M3_THINKING_LEVELS = [...BUDGET_THINKING_LEVELS, "adaptive"] as const;

export function resolveMinimaxThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  if (/^MiniMax-M3(\b|[-.])/i.test(modelId)) {
    return {
      levels: M3_THINKING_LEVELS.map((id) => ({ id })),
      defaultLevel: "adaptive",
    };
  }
  if (/^MiniMax-M2(?:\b|[-.])/i.test(modelId)) {
    return {
      levels: BUDGET_THINKING_LEVELS.map((id) => ({ id })),
      defaultLevel: "off",
    };
  }
  return undefined;
}
