/** Projects CLI run usage onto the persisted assistant transcript record. */
import type { NormalizedUsage } from "./usage.js";

export type CliTranscriptUsage = Pick<
  NormalizedUsage,
  "input" | "output" | "cacheRead" | "cacheWrite" | "total" | "contextUsage"
>;

const CLI_TRANSCRIPT_UNAVAILABLE_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  contextUsage: { state: "unavailable" },
} as const;

/**
 * Transcript counters account for the whole turn; `contextUsage` stays the latest call's
 * prompt size so context readers never size the window from a multi-call aggregate.
 */
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
