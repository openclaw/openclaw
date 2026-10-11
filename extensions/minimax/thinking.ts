// MiniMax thinking policy keeps M3 active by default while preserving M2.x leak prevention.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

export const MINIMAX_M31_MODEL_ID = "MiniMax-M3.1-Flash-Preview";

const BUDGET_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const ADAPTIVE_THINKING_LEVELS = ["off", "adaptive"] as const;
export const MINIMAX_M31_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export function isMinimaxM31ModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase() === MINIMAX_M31_MODEL_ID.toLowerCase();
}

export function resolveMinimaxThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  if (isMinimaxM31ModelId(modelId)) {
    return {
      levels: MINIMAX_M31_THINKING_LEVELS.map((id) => ({ id })),
      defaultLevel: "max",
    };
  }
  if (/^MiniMax-M3(\b|[-.])/i.test(modelId)) {
    return {
      levels: ADAPTIVE_THINKING_LEVELS.map((id) => ({ id })),
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
