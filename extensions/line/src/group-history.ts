// Line plugin module implements group history behavior.
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";

function lineHistoryEntryKey(entry: HistoryEntry): string {
  return entry.messageId ?? `${entry.timestamp ?? ""}:${entry.sender}:${entry.body}`;
}

// Fire-and-forget webhook dispatch runs group events in parallel, so a plain
// (unmentioned) message can be recorded while the agent is still handling a
// mention. The turn must read the window and capture the identity keys it
// consumed in one synchronous step: a key captured before the read could miss
// entries the turn sees (duplicated next turn), and a whole-key clear would
// drop entries the turn never saw (lost messages).
export function snapshotLineGroupHistory(
  historyMap: Map<string, HistoryEntry[]> | undefined,
  historyKey: string | undefined,
  limit: number,
): { inboundHistory?: HistoryEntry[]; consumedKeys?: Set<string> } {
  if (!historyMap || !historyKey || limit <= 0) {
    return {};
  }
  const inboundHistory = createChannelHistoryWindow({ historyMap }).buildInboundHistory({
    historyKey,
    limit,
  });
  return {
    inboundHistory,
    consumedKeys: new Set((inboundHistory ?? []).map(lineHistoryEntryKey)),
  };
}

// Clear only the entries the turn consumed (captured in consumedKeys); retain
// anything recorded concurrently. A whole-key clear would drop those and
// silently lose group messages that arrived while the agent was running.
export function clearConsumedLineGroupHistory(
  historyMap: Map<string, HistoryEntry[]> | undefined,
  historyKey: string | undefined,
  consumedKeys: Set<string> | undefined,
): void {
  if (!historyMap || !historyKey || !consumedKeys) {
    return;
  }
  const entries = historyMap.get(historyKey);
  if (!entries) {
    return;
  }
  const kept = entries.filter((entry) => !consumedKeys.has(lineHistoryEntryKey(entry)));
  if (kept.length > 0) {
    historyMap.set(historyKey, kept);
  } else {
    historyMap.delete(historyKey);
  }
}
