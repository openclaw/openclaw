/**
 * Post-restart orphan recovery for subagent sessions.
 *
 * After a SIGUSR1 gateway reload aborts in-flight subagent LLM calls,
 * this module scans for orphaned sessions (those with `abortedLastRun: true`
 * that are still tracked as active in the subagent registry) and sends a
 * synthetic resume message to restart their work.
 *
 * @see https://github.com/openclaw/openclaw/issues/47711
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";
/**
 * Scan for and resume orphaned subagent sessions after a gateway restart.
 *
 * An orphaned session is one where:
 * 1. It has an active (not ended) entry in the subagent run registry
 * 2. Its session store entry has `abortedLastRun: true`
 *
 * For each orphaned session found, we:
 * 1. Clear the `abortedLastRun` flag
 * 2. Send a synthetic resume message to trigger a new LLM turn
 */
export declare function recoverOrphanedSubagentSessions(params: {
    getActiveRuns: () => Map<string, SubagentRunRecord>;
    /** Persisted across retries so already-resumed sessions are not resumed again. */
    resumedSessionKeys?: Set<string>;
    /** Human-visible attempt number for this recovery pass. */
    attemptNumber?: number;
    /** Total recovery attempts before giving up. */
    maxAttempts?: number;
    /** Persisted across retries so recovery-in-progress notices stay deduped. */
    notifiedRecoverySessionKeys?: Set<string>;
}): Promise<{
    recovered: number;
    failed: number;
    skipped: number;
    failedRuns: Array<{
        runId: string;
        childSessionKey: string;
        error?: string;
    }>;
}>;
/**
 * Schedule orphan recovery after a delay, with retry logic.
 * The delay gives the gateway time to fully bootstrap after restart.
 * If recovery fails (e.g. gateway not yet ready), retries with exponential backoff.
 */
export declare function scheduleOrphanRecovery(params: {
    getActiveRuns: () => Map<string, SubagentRunRecord>;
    delayMs?: number;
    maxRetries?: number;
}): void;
