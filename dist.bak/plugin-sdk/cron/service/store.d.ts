import type { CronServiceState } from "./state.js";
export declare function ensureLoaded(state: CronServiceState, opts?: {
    forceReload?: boolean;
    /** Skip recomputing nextRunAtMs after load so the caller can run due
     *  jobs against the persisted values first (see onTimer). */
    skipRecompute?: boolean;
}): Promise<void>;
export declare function warnIfDisabled(state: CronServiceState, action: string): void;
export declare function persist(state: CronServiceState): Promise<void>;
