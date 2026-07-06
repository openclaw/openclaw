/**
 * Session defaults.
 *
 * Centralizes fallback thinking settings for sessions without model-specific overrides.
 */
import {
  resolveThinkingDefaultForModel,
  type ThinkingCatalogEntry,
} from "../../auto-reply/thinking.js";
import type { Model } from "../../llm/types.js";
import type { ThinkingLevel } from "../runtime/index.js";

type ThinkingCatalogCompat = NonNullable<ThinkingCatalogEntry["compat"]>;

/** Default thinking level for sessions that do not specify a model-specific override. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

function projectThinkingCatalogCompat(compat: Model["compat"]) {
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  const record = compat as Record<string, unknown>;
  const projected: ThinkingCatalogCompat = {};
  if (typeof record.thinkingFormat === "string") {
    projected.thinkingFormat = record.thinkingFormat;
  }
  if (record.supportedReasoningEfforts === null) {
    projected.supportedReasoningEfforts = null;
  } else if (
    Array.isArray(record.supportedReasoningEfforts) &&
    record.supportedReasoningEfforts.every((effort) => typeof effort === "string")
  ) {
    projected.supportedReasoningEfforts = record.supportedReasoningEfforts;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/** Resolve the session-level default while preserving the SDK's non-off cost policy. */
export function resolveSessionThinkingDefault(model: Model): ThinkingLevel {
  const provider = model.api === "ollama" ? "ollama" : model.provider;
  const compat = projectThinkingCatalogCompat(model.compat);
  const resolved = resolveThinkingDefaultForModel({
    provider,
    model: model.id,
    catalog: [
      {
        provider,
        id: model.id,
        api: model.api,
        reasoning: model.reasoning,
        ...(model.params ? { params: model.params } : {}),
        ...(compat ? { compat } : {}),
      },
    ],
  });
  return resolved === "off" ? "off" : DEFAULT_THINKING_LEVEL;
}
