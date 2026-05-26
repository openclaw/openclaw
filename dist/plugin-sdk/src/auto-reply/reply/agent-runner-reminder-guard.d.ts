import type { ReplyPayload } from "../types.js";
export declare function hasUnbackedReminderCommitment(text: string): boolean;
/**
 * Returns true when the cron store has at least one enabled job that shares the
 * current session key. Used to suppress the "no reminder scheduled" guard note
 * when an existing cron (created in a prior turn) already covers the commitment.
 */
export declare function hasSessionRelatedCronJobs(params: {
    cronStorePath?: string;
    sessionKey?: string;
}): Promise<boolean>;
export declare function appendUnscheduledReminderNote(payloads: ReplyPayload[]): ReplyPayload[];
