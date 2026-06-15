// Fireworks plugin module implements thinking policy behavior.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { buildFireworksCatalogModels } from "./provider-catalog.js";

type FireworksThinkLevelId = ProviderThinkingProfile["levels"][number]["id"];

const WIRE_EFFORT_TO_THINK_LEVEL: Record<string, FireworksThinkLevelId> = {
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const FIREWORKS_THINKING_PROFILES = new Map<string, ProviderThinkingProfile>();
for (const model of buildFireworksCatalogModels()) {
  if (!model.reasoning) {
    FIREWORKS_THINKING_PROFILES.set(model.id, { levels: [{ id: "off" }] });
    continue;
  }
  const efforts = model.compat?.supportedReasoningEfforts;
  if (!efforts) {
    continue;
  }
  const levels = efforts
    .map((effort) => WIRE_EFFORT_TO_THINK_LEVEL[effort])
    .filter((id): id is FireworksThinkLevelId => id !== undefined)
    .map((id) => ({ id }));
  if (levels.length > 0) {
    FIREWORKS_THINKING_PROFILES.set(model.id, { levels });
  }
}

export function resolveFireworksThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return FIREWORKS_THINKING_PROFILES.get(modelId.trim());
}
