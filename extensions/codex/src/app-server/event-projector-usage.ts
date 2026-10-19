import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asSafeIntegerInRange,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type JsonObject } from "./protocol.js";

function readTokenCount(record: JsonObject, key: string): number | undefined {
  return asSafeIntegerInRange(record[key], { min: 0 });
}

export function readCodexThreadContextSnapshot(params: JsonObject) {
  const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
  const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
  const modelContextWindow = tokenUsage
    ? readTokenCount(tokenUsage, "modelContextWindow")
    : undefined;
  // `last.totalTokens` is the provider-backed active-context base; `tokenUsage.total` is billing.
  const activeContextTokens = last ? readTokenCount(last, "totalTokens") : undefined;
  const inputTokens = last ? readTokenCount(last, "inputTokens") : undefined;
  const cachedInputTokens = last ? readTokenCount(last, "cachedInputTokens") : undefined;
  const cacheWriteInputTokens = last ? readTokenCount(last, "cacheWriteInputTokens") : undefined;
  const reasoningOutputTokens = last ? readTokenCount(last, "reasoningOutputTokens") : undefined;
  return {
    ...(activeContextTokens !== undefined ? { activeContextTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(modelContextWindow && modelContextWindow > 0 ? { modelContextWindow } : {}),
    ...(inputTokens !== undefined ? { promptTokens: inputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

type CodexResponseUsage = Pick<
  NonNullable<ReturnType<typeof normalizeUsage>>,
  "input" | "output" | "cacheRead" | "cacheWrite" | "reasoningTokens" | "total"
> & { promptTokens?: number };

function normalizeCodexResponseTokenUsage(
  record: JsonObject,
):
  | { usage: NonNullable<ReturnType<typeof normalizeUsage>>; observedUsage: CodexResponseUsage }
  | undefined {
  // v2 TokenUsageBreakdown. inputTokens includes cached input; OpenClaw usage
  // tracks uncached input, cache reads, and cache writes separately.
  const totalTokens = readTokenCount(record, "totalTokens");
  const inputTokens = readTokenCount(record, "inputTokens");
  const cacheRead = readTokenCount(record, "cachedInputTokens");
  const output = readTokenCount(record, "outputTokens");
  const reasoningTokens = readTokenCount(record, "reasoningOutputTokens");
  const reportedCacheWrite = readTokenCount(record, "cacheWriteInputTokens");
  const cacheWrite = record.cacheWriteInputTokens === undefined ? 0 : reportedCacheWrite;
  const hasCoherentInput =
    inputTokens !== undefined &&
    cacheRead !== undefined &&
    cacheWrite !== undefined &&
    cacheRead + cacheWrite <= inputTokens;
  const hasCoherentContext =
    hasCoherentInput &&
    totalTokens !== undefined &&
    output !== undefined &&
    totalTokens === inputTokens + output;

  const usage = normalizeUsage({
    input: hasCoherentInput ? inputTokens - cacheRead - cacheWrite : undefined,
    output,
    cacheRead,
    cacheWrite,
    reasoningTokens,
    total: totalTokens,
  });
  if (!usage) {
    return undefined;
  }

  return {
    usage: {
      ...usage,
      contextUsage: hasCoherentContext
        ? { state: "available", promptTokens: inputTokens, totalTokens }
        : { state: "unavailable" },
    },
    // Aggregate compatibility defaults are not evidence that the provider
    // reported a field. Uncached input needs every cache component to be known.
    observedUsage: {
      ...(hasCoherentInput && reportedCacheWrite !== undefined
        ? { input: inputTokens - cacheRead - reportedCacheWrite }
        : {}),
      ...(inputTokens !== undefined ? { promptTokens: inputTokens } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(reportedCacheWrite !== undefined ? { cacheWrite: reportedCacheWrite } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      ...(totalTokens !== undefined ? { total: totalTokens } : {}),
    },
  };
}

export class CodexUsageProjection {
  // Replayed notifications keep one upstream response equal to one model iteration.
  private readonly responseIds = new Set<string>();
  private responseUsage: ReturnType<typeof normalizeUsage>;
  private threadUsage: ReturnType<typeof normalizeUsage>;
  private contextUsage: NonNullable<ReturnType<typeof normalizeUsage>>["contextUsage"];

  get usage(): ReturnType<typeof normalizeUsage> {
    const usage = this.responseUsage ?? this.threadUsage;
    return usage ? { ...usage, contextUsage: this.contextUsage } : undefined;
  }

  get modelIterations(): number {
    return this.responseIds.size;
  }

  invalidateContext(): void {
    this.contextUsage = { state: "unavailable" };
  }

  recordThread(params: JsonObject): ReturnType<typeof readCodexThreadContextSnapshot> {
    const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
    const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
    const usage = last ? normalizeCodexResponseTokenUsage(last)?.usage : undefined;
    this.threadUsage = usage ?? this.threadUsage;
    if (!this.responseUsage && usage) {
      this.contextUsage = usage.contextUsage;
    }
    return readCodexThreadContextSnapshot(params);
  }

  record(
    params: JsonObject,
    reportOutputTokens?: (outputTokens: number) => void,
  ): { responseId: string; usage: CodexResponseUsage | undefined } | undefined {
    const responseId = readString(params, "responseId");
    if (!responseId || this.responseIds.has(responseId)) {
      return undefined;
    }
    this.responseIds.add(responseId);
    const normalized = isJsonObject(params.usage)
      ? normalizeCodexResponseTokenUsage(params.usage)
      : undefined;
    const usage = normalized?.usage;
    // Billing sums completed calls; context belongs only to the latest call.
    // Missing usage or a retry invalidates context without erasing paid work.
    this.contextUsage = usage?.contextUsage ?? { state: "unavailable" };
    this.responseUsage ??= {};
    for (const field of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "reasoningTokens",
      "total",
    ] as const) {
      if (usage?.[field] !== undefined) {
        this.responseUsage[field] = (this.responseUsage[field] ?? 0) + usage[field];
      }
    }
    const outputTokens = usage?.output;
    if (outputTokens !== undefined) {
      reportOutputTokens?.(outputTokens);
    }
    return { responseId, usage: normalized?.observedUsage };
  }
}
