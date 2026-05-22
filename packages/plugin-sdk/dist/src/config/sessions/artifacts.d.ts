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
export declare function parseUsageCountedSessionIdFromFileName(fileName: string): string | null;
export declare function formatSessionArchiveTimestamp(nowMs?: number): string;
export declare function parseSessionArchiveTimestamp(fileName: string, reason: SessionArchiveReason): number | null;
