import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
/**
 * Shared helpers for clearing assistant usage snapshots invalidated by
 * transcript compaction.
 */
import type { AgentMessage } from "./runtime/index.js";
import { makeZeroUsageSnapshot } from "./usage.js";

export function stripStaleAssistantUsageBeforeLatestCompaction<TMessage extends AgentMessage>(
  messages: TMessage[],
  options: {
    mutate?: boolean;
    whenMissingCompactionSummary?: "preserve" | "zeroAssistantUsage";
  } = {},
): TMessage[] {
  const latestCompactionSummaryIndex = messages.findLastIndex(
    (entry) => entry?.role === "compactionSummary",
  );
  const hasCompactionSummary = latestCompactionSummaryIndex !== -1;
  if (!hasCompactionSummary && options.whenMissingCompactionSummary !== "zeroAssistantUsage") {
    return messages;
  }

  const latestCompactionTimestamp = parseDateFirstTimestampMs(
    messages[latestCompactionSummaryIndex]?.timestamp,
  );
  let out = messages;
  for (let i = 0; i < messages.length; i += 1) {
    const candidate = messages[i];
    if (
      candidate?.role !== "assistant" ||
      !candidate.usage ||
      typeof candidate.usage !== "object"
    ) {
      continue;
    }

    const messageTimestamp = parseDateFirstTimestampMs(candidate.timestamp);
    const stale =
      !hasCompactionSummary ||
      (latestCompactionTimestamp !== undefined && messageTimestamp !== undefined
        ? messageTimestamp <= latestCompactionTimestamp
        : i < latestCompactionSummaryIndex);
    if (!stale) {
      continue;
    }

    // Session runtime expects assistant usage to stay structurally valid during
    // accounting. Keep stale snapshots present, but zeroed after compaction.
    if (out === messages && !options.mutate) {
      out = [...messages];
    }
    out[i] = { ...candidate, usage: makeZeroUsageSnapshot() } as TMessage;
  }
  return out;
}
