/**
 * Resolve Copilot thinking profile from API-provided capabilities.
 *
 * Maps the Copilot /models API capability fields to OpenClaw's
 * ProviderThinkingProfile structure, supporting:
 * - `adaptive_thinking` → enables adaptive/extended thinking
 * - `reasoning_effort` → available thinking levels
 * - `max_thinking_budget` / `min_thinking_budget` → budget constraints
 */

import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import type { CopilotModelCapabilities } from "./models-mapping.js";

// Inline from ProviderThinkingLevel since it's not exported from plugin-sdk
type ThinkingLevelId =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
type ThinkingLevel = { id: ThinkingLevelId; label?: string; rank?: number };

/**
 * Canonical ordering of thinking levels from lowest to highest.
 */
const LEVEL_RANK: Record<string, number> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  adaptive: 6,
  max: 7,
};

/**
 * Map a Copilot reasoning_effort level to an OpenClaw thinking level id.
 */
function mapReasoningEffortLevel(
  level: string,
): ThinkingLevelId | null {
  const lower = level.toLowerCase();
  switch (lower) {
    case "none":
      return "off";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return null;
  }
}

/**
 * Build a thinking profile from Copilot API capabilities.
 *
 * When capabilities are unavailable (API fetch failed), returns a
 * basic default profile.
 */
export function resolveThinkingProfileFromCapabilities(
  capabilities: CopilotModelCapabilities | undefined,
): ProviderThinkingProfile {
  // Default profile when no API data is available
  if (!capabilities) {
    return {
      levels: [
        { id: "off", rank: 0 },
        { id: "minimal", rank: 1 },
        { id: "low", rank: 2 },
        { id: "medium", rank: 3 },
        { id: "high", rank: 4 },
      ],
    };
  }

  const levels: ThinkingLevel[] = [{ id: "off", rank: 0 }];

  // Add levels from reasoning_effort
  const effortLevels = capabilities.reasoningEffort;
  if (effortLevels && effortLevels.length > 0) {
    // Always include minimal since OpenClaw uses it as the minimum "thinking on" level
    levels.push({ id: "minimal", rank: 1 });

    for (const level of effortLevels) {
      const mapped = mapReasoningEffortLevel(level);
      if (mapped && mapped !== "off") {
        // Avoid duplicates
        if (!levels.some((l) => l.id === mapped)) {
          levels.push({ id: mapped, rank: LEVEL_RANK[mapped] ?? 3 });
        }
      }
    }
  } else {
    // No reasoning_effort reported — provide basic levels
    levels.push(
      { id: "minimal", rank: 1 },
      { id: "low", rank: 2 },
      { id: "medium", rank: 3 },
      { id: "high", rank: 4 },
    );
  }

  // If model supports adaptive thinking (Claude), add adaptive level
  if (capabilities.adaptiveThinking) {
    if (!levels.some((l) => l.id === "adaptive")) {
      levels.push({ id: "adaptive", rank: 6 });
    }
  }

  // Sort by rank
  levels.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  return { levels };
}
