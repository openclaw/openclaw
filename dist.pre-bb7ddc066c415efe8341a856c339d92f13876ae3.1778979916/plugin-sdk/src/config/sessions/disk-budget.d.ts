import type { SessionEntry } from "./types.js";
export type SessionDiskBudgetConfig = {
    maxDiskBytes: number | null;
    highWaterBytes: number | null;
};
export type SessionDiskBudgetSweepResult = {
    totalBytesBefore: number;
    totalBytesAfter: number;
    removedFiles: number;
    removedEntries: number;
    freedBytes: number;
    maxBytes: number;
    highWaterBytes: number;
    overBudget: boolean;
};
export type SessionUnreferencedArtifactSweepResult = {
    scannedFiles: number;
    removedFiles: number;
    freedBytes: number;
    olderThanMs: number;
};
export type SessionDiskBudgetLogger = {
    warn: (message: string, context?: Record<string, unknown>) => void;
    info: (message: string, context?: Record<string, unknown>) => void;
};
export declare function resolveSessionArtifactCanonicalPathsForEntry(params: {
    sessionsDir: string;
    entry: SessionEntry;
}): string[];
export declare function pruneUnreferencedSessionArtifacts(params: {
    store: Record<string, SessionEntry>;
    storePath: string;
    olderThanMs: number;
    dryRun?: boolean;
    excludeCanonicalPaths?: ReadonlySet<string>;
}): Promise<SessionUnreferencedArtifactSweepResult>;
export declare function enforceSessionDiskBudget(params: {
    store: Record<string, SessionEntry>;
    storePath: string;
    activeSessionKey?: string;
    preserveKeys?: ReadonlySet<string>;
    maintenance: SessionDiskBudgetConfig;
    warnOnly: boolean;
    dryRun?: boolean;
    log?: SessionDiskBudgetLogger;
    onRemoveFile?: (canonicalPath: string) => void;
}): Promise<SessionDiskBudgetSweepResult | null>;
