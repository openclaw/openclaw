/**
 * Small shared normalization helpers for embedded-agent runner settings.
 */
import {
  resolveProviderThinkingLevel,
  type ThinkLevel,
  type ThinkingCatalogEntry,
} from "../../auto-reply/thinking.js";
import type { Model } from "../../llm/types.js";
import type { ThinkingLevel } from "../runtime/index.js";

export type ProviderThinkLevel = Exclude<ThinkLevel, "ultra">;

export function normalizeContextTokenBudget(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** Converts logical product modes into provider-facing effort values. */
export function mapThinkingLevelForProvider(
  level: ThinkLevel | undefined,
  model: ThinkingCatalogEntry | Model,
): ProviderThinkLevel | undefined {
  return resolveProviderThinkingLevel({
    provider: model.provider,
    model: model.id,
    catalog: [model],
    agentRuntime: "openclaw",
    level,
  });
}

export function mapThinkingLevel(providerLevel?: ProviderThinkLevel): ThinkingLevel {
  if (!providerLevel) {
    return "off";
  }
  // Runtime streams do not expose a distinct adaptive level. Preserve the
  // provider-owned adaptive default by using Claude's documented high effort.
  if (providerLevel === "adaptive") {
    return "high";
  }
  return providerLevel;
}

export type { ThinkLevel };
