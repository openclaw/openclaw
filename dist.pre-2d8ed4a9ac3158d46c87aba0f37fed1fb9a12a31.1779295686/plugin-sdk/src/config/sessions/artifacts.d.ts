export type SessionArchiveReason = "bak" | "reset" | "deleted";
export declare function isSessionArchiveArtifactName(fileName: string): boolean;
export declare function parseCompactionCheckpointTranscriptFileName(fileName: string): {
    sessionId: string;
    checkpointId: string;
} | null;
export declare function isCompactionCheckpointTranscriptFileName(fileName: string): boolean;
export declare function isTrajectoryRuntimeArtifactName(fileName: string): boolean;
export declare function isTrajectoryPointerArtifactName(fileName: string): boolean;
export declare function isTrajectorySessionArtifactName(fileName: string): boolean;
export declare function isPrimarySessionTranscriptFileName(fileName: string): boolean;
export declare function isUsageCountedSessionTranscriptFileName(fileName: string): boolean;
/**
 * Classify pre-compaction checkpoint-twin transcript files, e.g.
 * `<parentId>.checkpoint.<uuid>.jsonl`. Uses an anchored UUID-shape match so
 * session IDs that happen to contain the substring "checkpoint" do not
 * false-positive.
 */
export declare function isCheckpointSessionTranscriptFileName(fileName: string): boolean;
/**
 * Extract the parent session id from a checkpoint transcript file name. The
 * parent session id is the part BEFORE `.checkpoint.<uuid>.jsonl`; it matches
 * what `isPrimarySessionTranscriptFileName` expects when the parent primary
 * exists as `<parentId>.jsonl`. Returns `null` if the file is not a checkpoint.
 */
export declare function parseParentSessionIdFromCheckpointFileName(fileName: string): string | null;
export declare function parseUsageCountedSessionIdFromFileName(fileName: string): string | null;
export declare function formatSessionArchiveTimestamp(nowMs?: number): string;
export declare function parseSessionArchiveTimestamp(fileName: string, reason: SessionArchiveReason): number | null;
