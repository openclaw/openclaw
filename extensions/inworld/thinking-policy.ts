import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { getInworldReasoningLevels } from "./models.js";

type ProviderThinkingLevelId = ProviderThinkingProfile["levels"][number]["id"];

// /llm/v1alpha/models currently reports supportedLevels as proto enum names
// ("EFFORT_NONE".."EFFORT_XHIGH"); accept the lowercase short form too so
// the profile keeps working if Inworld switches to its wire spelling.
const INWORLD_EFFORT_TO_OPENCLAW: Record<string, ProviderThinkingLevelId> = {
  none: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

function normalizeInworldEffortKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^effort_/, "");
}

export function resolveInworldThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  const levels = getInworldReasoningLevels(modelId);
  if (!levels) {
    return undefined;
  }
  const ids: ProviderThinkingLevelId[] = [];
  for (const raw of levels) {
    const mapped = INWORLD_EFFORT_TO_OPENCLAW[normalizeInworldEffortKey(raw)];
    if (mapped) {
      ids.push(mapped);
    }
  }
  if (ids.length === 0) {
    return undefined;
  }
  return {
    levels: ids.map((id) => ({ id })),
    defaultLevel: ids.includes("medium") ? "medium" : (ids[ids.length - 1] ?? "off"),
  };
}
