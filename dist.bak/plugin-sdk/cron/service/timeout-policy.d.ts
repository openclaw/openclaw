import type { CronJob } from "../types.js";
/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of per-provider/per-agent timeouts to prevent one stuck job from
 * wedging the entire cron lane.
 */
export declare const DEFAULT_JOB_TIMEOUT_MS: number;
/**
 * Agent turns can legitimately run much longer than generic cron jobs.
 * Use a larger safety ceiling when no explicit timeout is set.
 */
export declare const AGENT_TURN_SAFETY_TIMEOUT_MS: number;
export declare function resolveCronJobTimeoutMs(job: CronJob): number | undefined;
