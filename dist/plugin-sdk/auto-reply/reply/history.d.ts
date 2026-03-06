export declare const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
export declare const DEFAULT_GROUP_HISTORY_LIMIT = 50;
/** Maximum number of group history keys to retain (LRU eviction when exceeded). */
export declare const MAX_HISTORY_KEYS = 1000;
/**
 * Evict oldest keys from a history map when it exceeds MAX_HISTORY_KEYS.
 * Uses Map's insertion order for LRU-like behavior.
 */
export declare function evictOldHistoryKeys<T>(historyMap: Map<string, T[]>, maxKeys?: number): void;
export type HistoryEntry = {
    sender: string;
    body: string;
    timestamp?: number;
    messageId?: string;
};
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
export declare function recordPendingHistoryEntry<T extends HistoryEntry>(params: {
    historyMap: Map<string, T[]>;
    historyKey: string;
    entry: T;
    limit: number;
}): T[];
export declare function recordPendingHistoryEntryIfEnabled<T extends HistoryEntry>(params: {
    historyMap: Map<string, T[]>;
    historyKey: string;
    entry?: T | null;
    limit: number;
}): T[];
export declare function buildPendingHistoryContextFromMap(params: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
    limit: number;
    currentMessage: string;
    formatEntry: (entry: HistoryEntry) => string;
    lineBreak?: string;
}): string;
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
export declare function clearHistoryEntries(params: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
}): void;
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
