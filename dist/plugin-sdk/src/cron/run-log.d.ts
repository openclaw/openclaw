import type { CronConfig } from "../config/types.cron.js";
import type { CronDeliveryStatus, CronDeliveryTrace, CronRunDiagnostics, CronRunStatus, CronRunTelemetry } from "./types.js";
export type CronRunLogEntry = {
    ts: number;
    jobId: string;
    action: "finished";
    status?: CronRunStatus;
    error?: string;
    summary?: string;
    diagnostics?: CronRunDiagnostics;
    delivered?: boolean;
    deliveryStatus?: CronDeliveryStatus;
    deliveryError?: string;
    delivery?: CronDeliveryTrace;
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
    runAtMs?: number;
    durationMs?: number;
    nextRunAtMs?: number;
} & CronRunTelemetry;
type CronRunLogSortDir = "asc" | "desc";
type CronRunLogStatusFilter = "all" | "ok" | "error" | "skipped";
type ReadCronRunLogPageOptions = {
    limit?: number;
    offset?: number;
    jobId?: string;
    status?: CronRunLogStatusFilter;
    statuses?: CronRunStatus[];
    deliveryStatus?: CronDeliveryStatus;
    deliveryStatuses?: CronDeliveryStatus[];
    query?: string;
    sortDir?: CronRunLogSortDir;
};
type CronRunLogPageResult = {
    entries: CronRunLogEntry[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
};
type ReadCronRunLogAllPageOptions = Omit<ReadCronRunLogPageOptions, "jobId"> & {
    storePath: string;
    jobNameById?: Record<string, string>;
};
export declare function resolveCronRunLogPath(params: {
    storePath: string;
    jobId: string;
}): string;
export declare const DEFAULT_CRON_RUN_LOG_MAX_BYTES = 2000000;
export declare const DEFAULT_CRON_RUN_LOG_KEEP_LINES = 2000;
export declare function resolveCronRunLogPruneOptions(cfg?: CronConfig["runLog"]): {
    maxBytes: number;
    keepLines: number;
};
export declare function getPendingCronRunLogWriteCountForTests(): number;
export declare function appendCronRunLog(filePath: string, entry: CronRunLogEntry, opts?: {
    maxBytes?: number;
    keepLines?: number;
}): Promise<void>;
export declare function readCronRunLogEntries(filePath: string, opts?: {
    limit?: number;
    jobId?: string;
}): Promise<CronRunLogEntry[]>;
export declare function readCronRunLogEntriesSync(filePath: string, opts?: {
    limit?: number;
    jobId?: string;
}): CronRunLogEntry[];
export declare function readCronRunLogEntriesPage(filePath: string, opts?: ReadCronRunLogPageOptions): Promise<CronRunLogPageResult>;
export declare function readCronRunLogEntriesPageAll(opts: ReadCronRunLogAllPageOptions): Promise<CronRunLogPageResult>;
export {};
