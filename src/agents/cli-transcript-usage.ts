import type { ContextUsage } from "./usage.js";

export type CliTranscriptUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  contextUsage?: ContextUsage;
};

const CLI_TRANSCRIPT_UNAVAILABLE_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  contextUsage: { state: "unavailable" },
} as const satisfies CliTranscriptUsage;

/** Keep whole-turn billing totals separate from the latest call's context size. */
export function resolveCliTranscriptUsage(
  lastCallUsage: CliTranscriptUsage | undefined,
  turnUsage: CliTranscriptUsage | undefined,
): CliTranscriptUsage {
  if (!lastCallUsage) {
    return CLI_TRANSCRIPT_UNAVAILABLE_USAGE;
  }
  const counters = turnUsage ?? lastCallUsage;
  if (lastCallUsage.contextUsage) {
    return { ...counters, contextUsage: lastCallUsage.contextUsage };
  }
  const promptTokens =
    (lastCallUsage.input ?? 0) + (lastCallUsage.cacheRead ?? 0) + (lastCallUsage.cacheWrite ?? 0);
  return {
    ...counters,
    contextUsage:
      promptTokens > 0
        ? {
            state: "available",
            promptTokens,
            totalTokens: promptTokens + (lastCallUsage.output ?? 0),
          }
        : { state: "unavailable" },
  };
}
