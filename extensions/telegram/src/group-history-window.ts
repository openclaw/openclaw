// Telegram plugin module implements group history window behavior.
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";

const TELEGRAM_GROUP_HISTORY_SELF_SUFFIX = " (you)";

export function buildTelegramGroupHistorySelfSender(name: string): string {
  return `${name}${TELEGRAM_GROUP_HISTORY_SELF_SUFFIX}`;
}

function isTelegramGroupHistorySelfEntry(entry: HistoryEntry): boolean {
  return entry.sender.endsWith(TELEGRAM_GROUP_HISTORY_SELF_SUFFIX);
}

export function selectTelegramGroupHistoryAfterLastSelf(
  entries: readonly HistoryEntry[],
): HistoryEntry[] {
  const lastSelfIndex = entries.findLastIndex(isTelegramGroupHistorySelfEntry);
  return lastSelfIndex === -1 ? [...entries] : entries.slice(lastSelfIndex + 1);
}

export function recordTelegramGroupHistoryEntry(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey?: string;
  limit: number;
  entry: HistoryEntry;
}): void {
  if (!params.historyKey) {
    return;
  }
  createChannelHistoryWindow({ historyMap: params.historyMap }).record({
    historyKey: params.historyKey,
    limit: params.limit,
    entry: params.entry,
  });
}
