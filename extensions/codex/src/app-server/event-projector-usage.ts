import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readNumber } from "./event-projector-values.js";
import type { JsonObject } from "./protocol.js";

export type CodexNormalizedTokenUsage = NonNullable<ReturnType<typeof normalizeCodexTokenUsage>>;

export function normalizeCodexTokenUsage(record: JsonObject): ReturnType<typeof normalizeUsage> {
  // v2 TokenUsageBreakdown. inputTokens includes cached input; OpenClaw usage
  // tracks uncached input and cache reads separately.
  const inputTokens = readNumber(record, "inputTokens");
  const cacheRead = readNumber(record, "cachedInputTokens");
  const input =
    inputTokens !== undefined && cacheRead !== undefined
      ? Math.max(0, inputTokens - cacheRead)
      : inputTokens;
  return normalizeUsage({
    input,
    output: readNumber(record, "outputTokens"),
    cacheRead,
    total: readNumber(record, "totalTokens"),
  });
}

/**
 * Map Codex absolute thread `tokenUsage.total` into the provider-neutral
 * contextUsage snapshot used for session totalTokensFresh /status.
 * Per-call `last` must stay on attempt/message accounting separately.
 */
export function buildCodexThreadContextUsage(
  absolute: CodexNormalizedTokenUsage | undefined,
): NonNullable<CodexNormalizedTokenUsage["contextUsage"]> | undefined {
  if (!absolute) {
    return undefined;
  }
  const promptTokens =
    (absolute.input ?? 0) + (absolute.cacheRead ?? 0) + (absolute.cacheWrite ?? 0);
  if (!(promptTokens > 0)) {
    return undefined;
  }
  const totalTokens =
    typeof absolute.total === "number" && Number.isFinite(absolute.total) && absolute.total > 0
      ? absolute.total
      : promptTokens + (absolute.output ?? 0);
  if (totalTokens < promptTokens) {
    return undefined;
  }
  return {
    state: "available",
    promptTokens,
    totalTokens,
  };
}

/** Merge per-call last usage with absolute thread contextUsage when present. */
export function projectCodexTokenUsage(params: {
  last?: JsonObject;
  total?: JsonObject;
}): CodexNormalizedTokenUsage | undefined {
  const perCall = params.last ? normalizeCodexTokenUsage(params.last) : undefined;
  const absolute = params.total ? normalizeCodexTokenUsage(params.total) : undefined;
  const contextUsage = buildCodexThreadContextUsage(absolute);
  if (!perCall && !contextUsage) {
    return undefined;
  }
  return {
    ...(perCall ?? {}),
    ...(contextUsage ? { contextUsage } : {}),
  };
}
