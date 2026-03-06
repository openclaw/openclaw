import type { CronJob, CronJobCreate, CronJobPatch } from "../types.js";
import type { CronServiceState } from "./state.js";
type CronJobsEnabledFilter = "all" | "enabled" | "disabled";
type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";
type CronSortDir = "asc" | "desc";
export type CronListPageOptions = {
    includeDisabled?: boolean;
    limit?: number;
    offset?: number;
    query?: string;
    enabled?: CronJobsEnabledFilter;
    sortBy?: CronJobsSortBy;
    sortDir?: CronSortDir;
};
export type CronListPageResult = {
    jobs: ReturnType<typeof sortJobs>;
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
};
export declare function start(state: CronServiceState): Promise<void>;
export declare function stop(state: CronServiceState): void;
export declare function status(state: CronServiceState): Promise<{
    enabled: boolean;
    storePath: string;
    jobs: number;
    nextWakeAtMs: number | null;
}>;
export declare function list(state: CronServiceState, opts?: {
    includeDisabled?: boolean;
}): Promise<CronJob[]>;
declare function sortJobs(jobs: CronJob[], sortBy: CronJobsSortBy, sortDir: CronSortDir): CronJob[];
export declare function listPage(state: CronServiceState, opts?: CronListPageOptions): Promise<{
    jobs: CronJob[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
}>;
export declare function add(state: CronServiceState, input: CronJobCreate): Promise<CronJob>;
export declare function update(state: CronServiceState, id: string, patch: CronJobPatch): Promise<CronJob>;
export declare function remove(state: CronServiceState, id: string): Promise<{
    readonly ok: false;
    readonly removed: false;
} | {
    readonly ok: true;
    readonly removed: boolean;
}>;
export declare function run(state: CronServiceState, id: string, mode?: "due" | "force"): Promise<{
    ok: boolean;
    ran: boolean;
    reason: "already-running";
    readonly jobId?: undefined;
    readonly startedAt?: undefined;
    readonly executionJob?: undefined;
} | {
    ok: boolean;
    ran: boolean;
    reason: "not-due";
    readonly jobId?: undefined;
    readonly startedAt?: undefined;
    readonly executionJob?: undefined;
} | {
    readonly ok: false;
    readonly ran?: undefined;
} | {
    readonly ok: true;
    readonly ran: true;
}>;
export declare function wakeNow(state: CronServiceState, opts: {
    mode: "now" | "next-heartbeat";
    text: string;
}): {
    readonly ok: false;
} | {
    readonly ok: true;
};
export {};
