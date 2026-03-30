import { type SessionArchiveReason } from "../config/sessions.js";
import type { SessionPreviewItem } from "./session-utils.types.js";
type SessionTitleFields = {
    firstUserMessage: string | null;
    lastMessagePreview: string | null;
};
export declare function readSessionMessages(sessionId: string, storePath: string | undefined, sessionFile?: string): unknown[];
export declare function resolveSessionTranscriptCandidates(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string): string[];
export type ArchiveFileReason = SessionArchiveReason;
export declare function archiveFileOnDisk(filePath: string, reason: ArchiveFileReason): string;
/**
 * Archives all transcript files for a given session.
 * Best-effort: silently skips files that don't exist or fail to rename.
 */
export declare function archiveSessionTranscripts(opts: {
    sessionId: string;
    storePath: string | undefined;
    sessionFile?: string;
    agentId?: string;
    reason: "reset" | "deleted";
    /**
     * When true, only archive files resolved under the session store directory.
     * This prevents maintenance operations from mutating paths outside the agent sessions dir.
     */
    restrictToStoreDir?: boolean;
}): string[];
export declare function cleanupArchivedSessionTranscripts(opts: {
    directories: string[];
    olderThanMs: number;
    reason?: ArchiveFileReason;
    nowMs?: number;
}): Promise<{
    removed: number;
    scanned: number;
}>;
export declare function capArrayByJsonBytes<T>(items: T[], maxBytes: number): {
    items: T[];
    bytes: number;
};
export declare function readSessionTitleFieldsFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string, opts?: {
    includeInterSession?: boolean;
}): SessionTitleFields;
export declare function readFirstUserMessageFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string, opts?: {
    includeInterSession?: boolean;
}): string | null;
export declare function readLastMessagePreviewFromTranscript(sessionId: string, storePath: string | undefined, sessionFile?: string, agentId?: string): string | null;
export declare function readSessionPreviewItemsFromTranscript(sessionId: string, storePath: string | undefined, sessionFile: string | undefined, agentId: string | undefined, maxItems: number, maxChars: number): SessionPreviewItem[];
export {};
