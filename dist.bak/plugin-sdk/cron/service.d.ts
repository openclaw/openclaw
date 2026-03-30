import * as ops from "./service/ops.js";
import { type CronServiceDeps } from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";
export type { CronEvent, CronServiceDeps } from "./service/state.js";
export declare class CronService {
    private readonly state;
    constructor(deps: CronServiceDeps);
    start(): Promise<void>;
    stop(): void;
    status(): Promise<{
        enabled: boolean;
        storePath: string;
        jobs: number;
        nextWakeAtMs: number | null;
    }>;
    list(opts?: {
        includeDisabled?: boolean;
    }): Promise<CronJob[]>;
    listPage(opts?: ops.CronListPageOptions): Promise<{
        jobs: CronJob[];
        total: number;
        offset: number;
        limit: number;
        hasMore: boolean;
        nextOffset: number | null;
    }>;
    add(input: CronJobCreate): Promise<CronJob>;
    update(id: string, patch: CronJobPatch): Promise<CronJob>;
    remove(id: string): Promise<{
        readonly ok: false;
        readonly removed: false;
    } | {
        readonly ok: true;
        readonly removed: boolean;
    }>;
    run(id: string, mode?: "due" | "force"): Promise<{
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
    getJob(id: string): CronJob | undefined;
    wake(opts: {
        mode: "now" | "next-heartbeat";
        text: string;
    }): {
        readonly ok: false;
    } | {
        readonly ok: true;
    };
}
