// Provides model selection, usage, and thinking-level utility helpers.
import {
  calculateUsageCost,
  resolveClaudeNativeThinkingLevelMap,
  requiresClaudeMandatoryAdaptiveThinking,
} from "@openclaw/llm-core";
import type { Api, Model, ModelThinkingLevel, Usage } from "./types.js";

/** Calculates and stores model cost fields from token usage and per-million pricing. */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  Object.assign(usage.cost, calculateUsageCost(usage, model.cost));
  return usage.cost;
}

/** Replaces the catalog estimate when the provider reports an authoritative billed total. */
export function applyProviderReportedUsageCost(usage: Usage, reportedCost: unknown): void {
  if (typeof reportedCost !== "number" || !Number.isFinite(reportedCost) || reportedCost < 0) {
    return;
  }
  usage.cost.total = reportedCost;
  usage.cost.totalOrigin = "provider-billed";
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function resolveThinkingLevelMap<TApi extends Api>(model: Model<TApi>) {
  return model.api === "anthropic-messages"
    ? (resolveClaudeNativeThinkingLevelMap(model) ?? model.thinkingLevelMap)
    : model.thinkingLevelMap;
}

function modelCompatSupportsReasoningEffort<TApi extends Api>(
  model: Model<TApi>,
  level: "xhigh" | "max",
): boolean {
  // SAFETY: compat is verified as an object at runtime before reading optional reasoning effort properties.
  const compat = model.compat as
    | {
        supportsReasoningEffort?: unknown;
        supportedReasoningEfforts?: unknown;
      }
    | undefined;
  if (!compat || typeof compat !== "object") {
    return false;
  }
  if (compat.supportsReasoningEffort === false) {
    return false;
  }
  if (!Object.hasOwn(compat, "supportedReasoningEfforts")) {
    return false;
  }
  const efforts = compat.supportedReasoningEfforts;
  if (!Array.isArray(efforts)) {
    return false;
  }
  return efforts.some((effort) => {
    if (typeof effort !== "string") {
      return false;
    }
    const normalized = effort.trim().toLowerCase();
    return normalized === level;
  });
}

/** Returns thinking levels exposed by a reasoning-capable model. */
export function getSupportedThinkingLevels<TApi extends Api>(
  model: Model<TApi>,
): ModelThinkingLevel[] {
  const mandatoryAdaptiveContract =
    model.api === "anthropic-messages" && requiresClaudeMandatoryAdaptiveThinking(model);
  if (!model.reasoning && !mandatoryAdaptiveContract) {
    return ["off"];
  }
  const thinkingLevelMap = resolveThinkingLevelMap(model);

  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined || modelCompatSupportsReasoningEffort(model, level);
    }
    return true;
  });
}

/** Clamps a requested thinking level to the closest supported level for a model. */
export function clampThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) {
    return level;
  }

  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }

  // Extended tiers (xhigh, max) must never clamp upward to a stronger level.
  // Walk down immediately to prevent unintended token spend and billing inflation.
  if (level === "xhigh" || level === "max") {
    for (const candidate of EXTENDED_THINKING_LEVELS.slice(0, requestedIndex).toReversed()) {
      if (availableLevels.includes(candidate)) {
        return candidate;
      }
    }
    return availableLevels[0] ?? "off";
  }

  // Prefer the next stronger available level, then walk down if the request was above the model cap.
  for (const candidate of EXTENDED_THINKING_LEVELS.slice(requestedIndex)) {
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  for (const candidate of EXTENDED_THINKING_LEVELS.slice(0, requestedIndex).toReversed()) {
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  return availableLevels[0] ?? "off";
}

/** Compares model identity by provider and id. */
export function modelsAreEqual<TApi extends Api>(
  a: Model<TApi> | null | undefined,
  b: Model<TApi> | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.id === b.id && a.provider === b.provider;
}
