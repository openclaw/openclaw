export type VolatileFilterPlan = {
    /** Canonical state directories the filter should treat as volatile anchors. */
    stateDirs: string[];
};
/**
 * Returns true if the given absolute path should be skipped during backup
 * because it is a live-mutation target.
 *
 * Rules:
 *   - `{stateDir}/sessions/**`/`*.{jsonl,log}` (legacy)
 *   - `{stateDir}/agents/<agentId>/sessions/**`/`*.{jsonl,log}`
 *   - `{stateDir}/cron/runs/**`/`*.{jsonl,log}`
 *   - `{stateDir}/logs/**`/`*.{jsonl,log}`
 *   - `{stateDir}/{delivery-queue,session-delivery-queue}/**`/`*.{json,tmp}`
 *   - `{stateDir}/**`/`*.{sock,pid,tmp}`
 */
export declare function isVolatileBackupPath(absolutePath: string, plan: VolatileFilterPlan): boolean;
