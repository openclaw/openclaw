import type { HistoryEntry, HistoryMediaEntry } from "./history.types.js";
export declare const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
export declare const DEFAULT_GROUP_HISTORY_LIMIT = 50;
/**
 * Evict oldest keys from a history map when it exceeds MAX_HISTORY_KEYS.
 * Uses Map's insertion order for LRU-like behavior.
 */
export declare function evictOldHistoryKeys<T>(historyMap: Map<string, T[]>, maxKeys?: number): void;
export type { HistoryEntry, HistoryMediaEntry } from "./history.types.js";
export declare function buildHistoryContext(params: {
    historyText: string;
    currentMessage: string;
    lineBreak?: string;
}): string;
export declare function appendHistoryEntry<T extends HistoryEntry>(params: {
    historyMap: Map<string, T[]>;
    historyKey: string;
    entry: T;
    limit: number;
}): T[];
/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).record(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
export declare function recordPendingHistoryEntry<T extends HistoryEntry>(params: {
    historyMap: Map<string, T[]>;
    historyKey: string;
    entry: T;
    limit: number;
}): T[];
/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).record(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
export declare function recordPendingHistoryEntryIfEnabled<T extends HistoryEntry>(params: {
    historyMap: Map<string, T[]>;
    historyKey: string;
    entry?: T | null;
    limit: number;
}): T[];
type MaybePromise<T> = T | Promise<T>;
export declare function normalizeHistoryMediaEntries(params: {
    media?: readonly HistoryMediaEntry[] | null;
    limit?: number;
    messageId?: string;
}): HistoryMediaEntry[];
/**
 * @deprecated Plugin message-turn code should use
 * `createChannelHistoryWindow(...).recordWithMedia(...)`. This helper remains
 * for core internals and older plugin compatibility.
 */
export declare function recordPendingHistoryEntryWithMedia<T extends HistoryEntry>(params: {
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
export declare function buildPendingHistoryContextFromMap(params: {
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
export declare function buildInboundHistoryFromMap<T extends HistoryEntry>(params: {
    historyMap: Map<string, T[]>;
    historyKey: string;
    limit: number;
}): HistoryEntry[] | undefined;
export declare function buildInboundHistoryFromEntries(params: {
    entries: readonly HistoryEntry[];
    limit: number;
}): HistoryEntry[] | undefined;
/**
 * @deprecated Prefer `buildHistoryContextFromEntries(...)` for existing entry
 * arrays, or `createChannelHistoryWindow(...)` when working from a history map.
 * This helper remains for older plugin compatibility.
 */
export declare function buildHistoryContextFromMap(params: {
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
export declare function clearHistoryEntries(params: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
}): void;
/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).clear(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
export declare function clearHistoryEntriesIfEnabled(params: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
    limit: number;
}): void;
export declare function buildHistoryContextFromEntries(params: {
    entries: HistoryEntry[];
    currentMessage: string;
    formatEntry: (entry: HistoryEntry) => string;
    lineBreak?: string;
    excludeLast?: boolean;
}): string;
