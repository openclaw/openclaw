import type { SessionPreviewItem } from "./session-utils.types.js";
type SessionTitleFields = {
    firstUserMessage: string | null;
    lastMessagePreview: string | null;
};
export declare function attachOpenClawTranscriptMeta(message: unknown, meta: Record<string, unknown>): unknown;
export declare function readSessionMessages(sessionId: string, storePath: string | undefined, sessionFile?: string): unknown[];
export type ReadRecentSessionMessagesOptions = {
    maxMessages: number;
    maxBytes?: number;
    maxLines?: number;
};
export type ReadSessionMessagesAsyncOptions = {
    mode: "full";
    reason: string;
} | ({
    mode: "recent";
} & ReadRecentSessionMessagesOptions);
type ReadRecentSessionMessagesResult = {
    messages: unknown[];
    totalMessages: number;
};
export declare function readRecentSessionMessages(sessionId: string, storePath: string | undefined, sessionFile?: string, opts?: ReadRecentSessionMessagesOptions): unknown[];
export declare function visitSessionMessages(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, visit: (message: unknown, seq: number) => void): number;
export declare function readSessionMessageCount(sessionId: string, storePath: string | undefined, sessionFile?: string): number;
export declare function readSessionMessagesAsync(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, opts: ReadSessionMessagesAsyncOptions): Promise<unknown[]>;
export declare function visitSessionMessagesAsync(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, visit: (message: unknown, seq: number) => void, _opts: {
    mode: "full";
    reason: string;
}): Promise<number>;
export declare function readSessionMessageCountAsync(sessionId: string, storePath: string | undefined, sessionFile?: string): Promise<number>;
export declare function readRecentSessionMessagesWithStats(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, opts: ReadRecentSessionMessagesOptions): ReadRecentSessionMessagesResult;
export declare function readRecentSessionMessagesAsync(sessionId: string, storePath: string | undefined, sessionFile?: string, opts?: ReadRecentSessionMessagesOptions): Promise<unknown[]>;
export declare function readRecentSessionMessagesWithStatsAsync(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, opts: ReadRecentSessionMessagesOptions): Promise<ReadRecentSessionMessagesResult>;
export declare function readRecentSessionTranscriptLines(params: {
    sessionId: string;
    storePath: string | undefined;
    sessionFile?: string;
    agentId?: string;
    maxLines: number;
}): {
    lines: string[];
    totalLines: number;
} | null;
export { archiveFileOnDisk, archiveSessionTranscripts, cleanupArchivedSessionTranscripts, resolveSessionTranscriptCandidates, } from "./session-transcript-files.fs.js";
export declare function capArrayByJsonBytes<T>(items: T[], maxBytes: number): {
    items: T[];
    bytes: number;
};
export declare function readSessionTitleFieldsFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string, opts?: {
    includeInterSession?: boolean;
}): SessionTitleFields;
export declare function readSessionTitleFieldsFromTranscriptAsync(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string, opts?: {
    includeInterSession?: boolean;
}): Promise<SessionTitleFields>;
export declare function readFirstUserMessageFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string, opts?: {
    includeInterSession?: boolean;
}): string | null;
export declare function readLastMessagePreviewFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string): string | null;
type SessionTranscriptUsageSnapshot = {
    modelProvider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    totalTokensFresh?: boolean;
    costUsd?: number;
};
export declare function readLatestSessionUsageFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string): SessionTranscriptUsageSnapshot | null;
export declare function readLatestSessionUsageFromTranscriptAsync(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string): Promise<SessionTranscriptUsageSnapshot | null>;
export declare function readRecentSessionUsageFromTranscriptAsync(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, agentId: string | undefined, maxBytes: number): Promise<SessionTranscriptUsageSnapshot | null>;
export declare function readLatestRecentSessionUsageFromTranscriptAsync(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, agentId: string | undefined, maxBytes: number): Promise<SessionTranscriptUsageSnapshot | null>;
export declare function readRecentSessionUsageFromTranscript(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, agentId: string | undefined, maxBytes: number): SessionTranscriptUsageSnapshot | null;
export declare function readSessionPreviewItemsFromTranscript(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, agentId: string | undefined, maxItems: number, maxChars: number): SessionPreviewItem[];
