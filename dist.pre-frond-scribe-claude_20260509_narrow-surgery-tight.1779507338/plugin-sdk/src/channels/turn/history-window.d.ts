import type { HistoryEntry, HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
type MaybePromise<T> = T | Promise<T>;
export type ChannelHistoryWindow<T extends HistoryEntry = HistoryEntry> = {
    record: (params: {
        historyKey: string;
        entry?: T | null;
        limit: number;
    }) => T[];
    recordWithMedia: (params: {
        historyKey: string;
        entry?: T | null;
        limit: number;
        media?: readonly HistoryMediaEntry[] | null | (() => MaybePromise<readonly HistoryMediaEntry[] | null | undefined>);
        mediaLimit?: number;
        messageId?: string;
        shouldRecord?: () => boolean;
    }) => Promise<T[]>;
    buildPendingContext: (params: {
        historyKey: string;
        limit: number;
        currentMessage: string;
        formatEntry: (entry: T) => string;
        lineBreak?: string;
    }) => string;
    buildInboundHistory: (params: {
        historyKey: string;
        limit: number;
    }) => HistoryEntry[] | undefined;
    clear: (params: {
        historyKey: string;
        limit: number;
    }) => void;
};
export declare function createChannelHistoryWindow<T extends HistoryEntry = HistoryEntry>(params: {
    historyMap: Map<string, T[]>;
}): ChannelHistoryWindow<T>;
export {};
