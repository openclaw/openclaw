import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionCompactionCheckpoint, SessionCompactionCheckpointReason, SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES: number;
export type CapturedCompactionCheckpointSnapshot = {
    sessionId: string;
    sessionFile: string;
    leafId: string;
};
type ForkedCompactionCheckpointTranscript = {
    sessionId: string;
    sessionFile: string;
};
export declare function resolveSessionCompactionCheckpointReason(params: {
    trigger?: "budget" | "overflow" | "manual";
    timedOut?: boolean;
}): SessionCompactionCheckpointReason;
export declare function readSessionLeafIdFromTranscriptAsync(sessionFile: string, maxBytes?: number): Promise<string | null>;
export declare function forkCompactionCheckpointTranscriptAsync(params: {
    sourceFile: string;
    targetCwd?: string;
    sessionDir?: string;
}): Promise<ForkedCompactionCheckpointTranscript | null>;
/**
 * Capture a bounded pre-compaction transcript snapshot without blocking the
 * Gateway event loop on synchronous file reads/copies.
 */
export declare function captureCompactionCheckpointSnapshotAsync(params: {
    sessionManager?: Pick<SessionManager, "getLeafId">;
    sessionFile: string;
    maxBytes?: number;
}): Promise<CapturedCompactionCheckpointSnapshot | null>;
export declare function cleanupCompactionCheckpointSnapshot(snapshot: CapturedCompactionCheckpointSnapshot | null | undefined): Promise<void>;
export declare function persistSessionCompactionCheckpoint(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    sessionId: string;
    reason: SessionCompactionCheckpointReason;
    snapshot: CapturedCompactionCheckpointSnapshot;
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore?: number;
    tokensAfter?: number;
    postSessionFile?: string;
    postLeafId?: string;
    postEntryId?: string;
    createdAt?: number;
}): Promise<SessionCompactionCheckpoint | null>;
export declare function listSessionCompactionCheckpoints(entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined): SessionCompactionCheckpoint[];
export declare function getSessionCompactionCheckpoint(params: {
    entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined;
    checkpointId: string;
}): SessionCompactionCheckpoint | undefined;
export {};
