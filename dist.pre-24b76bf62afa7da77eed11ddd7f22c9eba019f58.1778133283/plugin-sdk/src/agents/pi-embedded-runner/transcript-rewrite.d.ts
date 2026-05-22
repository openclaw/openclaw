import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { TranscriptRewriteReplacement, TranscriptRewriteRequest, TranscriptRewriteResult } from "../../context-engine/types.js";
import { type SessionWriteLockAcquireTimeoutConfig } from "../session-write-lock.js";
import { type TranscriptFileState } from "./transcript-file-state.js";
type SessionManagerLike = ReturnType<typeof SessionManager.open>;
type SessionBranchEntry = ReturnType<SessionManagerLike["getBranch"]>[number];
/**
 * Safely rewrites transcript message entries on the active branch by branching
 * from the first rewritten message's parent and re-appending the suffix.
 */
export declare function rewriteTranscriptEntriesInSessionManager(params: {
    sessionManager: SessionManagerLike;
    replacements: TranscriptRewriteReplacement[];
}): TranscriptRewriteResult;
export declare function rewriteTranscriptEntriesInState(params: {
    state: TranscriptFileState;
    replacements: TranscriptRewriteReplacement[];
}): TranscriptRewriteResult & {
    appendedEntries: SessionBranchEntry[];
};
/**
 * Open a transcript file, rewrite message entries on the active branch, and
 * emit a transcript update when the active branch changed.
 */
export declare function rewriteTranscriptEntriesInSessionFile(params: {
    sessionFile: string;
    sessionId?: string;
    sessionKey?: string;
    request: TranscriptRewriteRequest;
    config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<TranscriptRewriteResult>;
export {};
