import type { AgentMessage, NormalizedUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export type CopilotUsageSnapshot = NormalizedUsage;

function coerceTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

export function normalizeCopilotUsage(data: unknown): NormalizedUsage | undefined {
  const source = asOptionalObjectRecord(data);
  if (!source) {
    return undefined;
  }

  // SDK usage events only expose these four fields. Keep coercion identical to
  // the prior event-bridge implementation so invalid object-shaped events still
  // overwrite state with the legacy all-zero snapshot.
  const input = coerceTokenCount(source.inputTokens);
  const output = coerceTokenCount(source.outputTokens);
  const cacheRead = coerceTokenCount(source.cacheReadTokens);
  const cacheWrite = coerceTokenCount(source.cacheWriteTokens);
  const total = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);

  return {
    cacheRead,
    cacheWrite,
    input,
    output,
    total,
  };
}

export function buildCopilotAssistantUsage(params: {
  usage?: NormalizedUsage;
  fallbackOutputTokens?: unknown;
}): AssistantMessage["usage"] {
  const usage =
    params.usage ?? normalizeCopilotUsage({ outputTokens: params.fallbackOutputTokens });

  return {
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    totalTokens: usage?.total ?? 0,
  };
}
