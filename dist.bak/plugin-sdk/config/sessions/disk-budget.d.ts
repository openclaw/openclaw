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
export type SessionDiskBudgetLogger = {
    warn: (message: string, context?: Record<string, unknown>) => void;
    info: (message: string, context?: Record<string, unknown>) => void;
};
export declare function enforceSessionDiskBudget(params: {
    store: Record<string, SessionEntry>;
    storePath: string;
    activeSessionKey?: string;
    maintenance: SessionDiskBudgetConfig;
    warnOnly: boolean;
    dryRun?: boolean;
    log?: SessionDiskBudgetLogger;
}): Promise<SessionDiskBudgetSweepResult | null>;
