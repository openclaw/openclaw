import type { AgentMessage, NormalizedUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export type CopilotUsageSnapshot = NormalizedUsage;

export function normalizeCopilotUsage(data: unknown): NormalizedUsage | undefined {
  const source = asOptionalObjectRecord(data);
  if (!source) {
    return undefined;
  }

  // SDK usage events only expose these four fields. Keep coercion identical to
  // the prior event-bridge implementation so invalid object-shaped events still
  // overwrite state with the legacy all-zero snapshot.
  const input = resolveOptionalIntegerOption(source.inputTokens, { min: 0 });
  const output = resolveOptionalIntegerOption(source.outputTokens, { min: 0 });
  const cacheRead = resolveOptionalIntegerOption(source.cacheReadTokens, { min: 0 });
  const cacheWrite = resolveOptionalIntegerOption(source.cacheWriteTokens, { min: 0 });
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
