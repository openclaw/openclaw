import { n as HistoryMediaEntry, t as HistoryEntry } from "./history.types-D_WxL2c8.js";

//#region src/auto-reply/reply/history.d.ts
declare const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
declare const DEFAULT_GROUP_HISTORY_LIMIT = 50;
/**
 * Evict oldest keys from a history map when it exceeds MAX_HISTORY_KEYS.
 * Uses Map's insertion order for LRU-like behavior.
 */
declare function evictOldHistoryKeys<T>(historyMap: Map<string, T[]>, maxKeys?: number): void;
declare function buildHistoryContext(params: {
  historyText: string;
  currentMessage: string;
  lineBreak?: string;
}): string;
/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).record(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
declare function recordPendingHistoryEntry<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry: T;
  limit: number;
}): T[];
/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).record(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
declare function recordPendingHistoryEntryIfEnabled<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry?: T | null;
  limit: number;
}): T[];
type MaybePromise<T> = T | Promise<T>;
declare function normalizeHistoryMediaEntries(params: {
  media?: readonly HistoryMediaEntry[] | null;
  limit?: number;
  messageId?: string;
}): HistoryMediaEntry[];
/**
 * @deprecated Plugin message-turn code should use
 * `createChannelHistoryWindow(...).recordWithMedia(...)`. This helper remains
 * for core internals and older plugin compatibility.
 */
declare function recordPendingHistoryEntryWithMedia<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry?: T | null;
  limit: number;
  media?: readonly HistoryMediaEntry[] | null | (() => MaybePromise<readonly HistoryMediaEntry[] | null | undefined>);
  mediaLimit?: number;
  messageId?: string;
  shouldRecord?: () => boolean;
}): Promise<T[]>;
/**
 * @deprecated Plugin message-turn code should use
 * `createChannelHistoryWindow(...).buildPendingContext(...)`. This helper remains
 * for core internals and older plugin compatibility.
 */
declare function buildPendingHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
}): string;
/**
 * @deprecated Plugin message-turn code should use
 * `createChannelHistoryWindow(...).buildInboundHistory(...)`. This helper remains
 * for core internals and older plugin compatibility.
 */
declare function buildInboundHistoryFromMap<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  limit: number;
}): HistoryEntry[] | undefined;
declare function buildInboundHistoryFromEntries(params: {
  entries: readonly HistoryEntry[];
  limit: number;
}): HistoryEntry[] | undefined;
/**
 * @deprecated Prefer `buildHistoryContextFromEntries(...)` for existing entry
 * arrays, or `createChannelHistoryWindow(...)` when working from a history map.
 * This helper remains for older plugin compatibility.
 */
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
/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).clear(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
declare function clearHistoryEntries(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
}): void;
/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).clear(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
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
export { buildHistoryContextFromMap as a, buildPendingHistoryContextFromMap as c, evictOldHistoryKeys as d, normalizeHistoryMediaEntries as f, recordPendingHistoryEntryWithMedia as h, buildHistoryContextFromEntries as i, clearHistoryEntries as l, recordPendingHistoryEntryIfEnabled as m, HISTORY_CONTEXT_MARKER as n, buildInboundHistoryFromEntries as o, recordPendingHistoryEntry as p, buildHistoryContext as r, buildInboundHistoryFromMap as s, DEFAULT_GROUP_HISTORY_LIMIT as t, clearHistoryEntriesIfEnabled as u };