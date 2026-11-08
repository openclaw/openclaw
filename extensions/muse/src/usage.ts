import {
  normalizeUsage,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type MuseCompletionUsage = { prompt: number; total: number; reasoning: number };

const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** One MSP `session/tokenUsage` (one per model completion) for this turn, or undefined. */
function readMuseCompletionUsage(
  params: unknown,
  turnId: string | undefined,
): MuseCompletionUsage | undefined {
  if (!turnId || !isRecord(params) || params.turnId !== turnId) {
    return undefined;
  }
  const prompt = tokenCount(params.promptTokens);
  const total = tokenCount(params.totalTokens);
  const reasoning = isRecord(params.usage) ? tokenCount(params.usage.reasoningTokens) : undefined;
  return prompt !== undefined && total !== undefined && total >= prompt
    ? { prompt, total, reasoning: reasoning ?? 0 }
    : undefined;
}

// MSP's counted-once prompt and total tokens are summed as served; its schema
// forbids re-deriving the provider's cache split, so no cache read is reported.
export function museTurnUsage(
  notices: readonly unknown[],
  turnId: string | undefined,
): AgentHarnessAttemptResult["attemptUsage"] {
  const completions = notices.flatMap((notice) => readMuseCompletionUsage(notice, turnId) ?? []);
  const last = completions.at(-1);
  if (!last) {
    return undefined;
  }
  const sum = (key: keyof MuseCompletionUsage) =>
    completions.reduce((total, completion) => total + completion[key], 0);
  const usage = normalizeUsage({
    input: sum("prompt"),
    output: sum("total") - sum("prompt"),
    reasoningTokens: sum("reasoning"),
    total: sum("total"),
  });
  // The latest completion is the context the next turn starts from.
  return (
    usage && {
      ...usage,
      contextUsage: { state: "available", promptTokens: last.prompt, totalTokens: last.total },
    }
  );
}
