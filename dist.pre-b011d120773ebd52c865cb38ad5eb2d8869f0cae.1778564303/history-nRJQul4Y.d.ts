//#region src/auto-reply/reply/history.d.ts
declare const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
declare const DEFAULT_GROUP_HISTORY_LIMIT = 50;
/**
 * Evict oldest keys from a history map when it exceeds MAX_HISTORY_KEYS.
 * Uses Map's insertion order for LRU-like behavior.
 */
declare function evictOldHistoryKeys<T>(historyMap: Map<string, T[]>, maxKeys?: number): void;
type HistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};
declare function buildHistoryContext(params: {
  historyText: string;
  currentMessage: string;
  lineBreak?: string;
}): string;
declare function recordPendingHistoryEntry<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry: T;
  limit: number;
}): T[];
declare function recordPendingHistoryEntryIfEnabled<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry?: T | null;
  limit: number;
}): T[];
declare function buildPendingHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
}): string;
declare function buildHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  entry?: HistoryEntry;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
  excludeLast?: boolean;
}): string;
declare function clearHistoryEntries(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
}): void;
declare function clearHistoryEntriesIfEnabled(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
}): void;
declare function buildHistoryContextFromEntries(params: {
  entries: HistoryEntry[];
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
  excludeLast?: boolean;
}): string;
//#endregion
export { buildHistoryContextFromEntries as a, clearHistoryEntries as c, recordPendingHistoryEntry as d, recordPendingHistoryEntryIfEnabled as f, buildHistoryContext as i, clearHistoryEntriesIfEnabled as l, HISTORY_CONTEXT_MARKER as n, buildHistoryContextFromMap as o, HistoryEntry as r, buildPendingHistoryContextFromMap as s, DEFAULT_GROUP_HISTORY_LIMIT as t, evictOldHistoryKeys as u };