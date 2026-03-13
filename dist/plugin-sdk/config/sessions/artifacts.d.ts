export type SessionArchiveReason = "bak" | "reset" | "deleted";
export declare function isSessionArchiveArtifactName(fileName: string): boolean;
export declare function isPrimarySessionTranscriptFileName(fileName: string): boolean;
export declare function formatSessionArchiveTimestamp(nowMs?: number): string;
export declare function parseSessionArchiveTimestamp(fileName: string, reason: SessionArchiveReason): number | null;
