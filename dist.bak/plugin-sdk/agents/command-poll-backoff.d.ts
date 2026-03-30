import type { SessionState } from "../logging/diagnostic-session-state.js";
/**
 * Calculate suggested retry delay based on consecutive no-output poll count.
 * Implements exponential backoff schedule: 5s → 10s → 30s → 60s (capped).
 */
export declare function calculateBackoffMs(consecutiveNoOutputPolls: number): number;
/**
 * Record a command poll and return suggested retry delay.
 * @param state Session state to track polling in
 * @param commandId Unique identifier for the command being polled
 * @param hasNewOutput Whether this poll returned new output
 * @returns Suggested delay in milliseconds before next poll
 */
export declare function recordCommandPoll(state: SessionState, commandId: string, hasNewOutput: boolean): number;
/**
 * Get current suggested backoff for a command without modifying state.
 * Useful for checking current backoff level.
 */
export declare function getCommandPollSuggestion(state: SessionState, commandId: string): number | undefined;
/**
 * Reset poll count for a command (e.g., when command completes).
 */
export declare function resetCommandPollCount(state: SessionState, commandId: string): void;
/**
 * Prune stale command poll records (older than 1 hour).
 * Call periodically to prevent memory bloat.
 */
export declare function pruneStaleCommandPolls(state: SessionState, maxAgeMs?: number): void;
