import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { TranscriptRewriteReplacement, TranscriptRewriteRequest, TranscriptRewriteResult } from "../../context-engine/types.js";
type SessionManagerLike = ReturnType<typeof SessionManager.open>;
/**
 * Safely rewrites transcript message entries on the active branch by branching
 * from the first rewritten message's parent and re-appending the suffix.
 */
export declare function rewriteTranscriptEntriesInSessionManager(params: {
    sessionManager: SessionManagerLike;
    replacements: TranscriptRewriteReplacement[];
}): TranscriptRewriteResult;
/**
 * Open a transcript file, rewrite message entries on the active branch, and
 * emit a transcript update when the active branch changed.
 */
export declare function rewriteTranscriptEntriesInSessionFile(params: {
    sessionFile: string;
    sessionId?: string;
    sessionKey?: string;
    request: TranscriptRewriteRequest;
}): Promise<TranscriptRewriteResult>;
export {};
