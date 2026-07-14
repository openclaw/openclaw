// Line plugin module implements group history behavior.
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";

function lineHistoryEntryKey(entry: HistoryEntry): string {
  return entry.messageId ?? `${entry.timestamp ?? ""}:${entry.sender}:${entry.body}`;
}

// Snapshot the identity keys a mention turn is about to consume. Fire-and-forget
// webhook dispatch runs group events in parallel, so a plain (unmentioned)
// message can be recorded while the agent is still handling a mention; capturing
// the keys up front lets the post-turn cleanup drop exactly what the turn read
// and keep anything that arrived concurrently.
export function snapshotLineGroupHistoryKeys(
  historyMap: Map<string, HistoryEntry[]> | undefined,
  historyKey: string | undefined,
): Set<string> | undefined {
  if (!historyMap || !historyKey) {
    return undefined;
  }
  return new Set((historyMap.get(historyKey) ?? []).map(lineHistoryEntryKey));
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
