/**
 * Continuation signal extraction and merging.
 *
 * This module owns the logic that produces a unified ContinuationSignal from
 * either bracket syntax in response text or tool-call requests captured during
 * the agent turn. The runner calls this after the agent response finalizes.
 *
 * RFC: docs/design/continue-work-signal-v2.md §2.1, §3.4
 */
import type { ContinuationSignal } from "./types.js";
import type { ContinueWorkRequest } from "./types.js";
export type { ContinueWorkRequest };
/**
 * A reply payload with optional text content.
 * Matches the shape used by agent-runner.ts payload arrays.
 */
export type ReplyPayload = {
    text?: string;
    [key: string]: unknown;
};
/**
 * Result of extracting continuation signals from a completed agent turn.
 */
export type ContinuationSignalExtraction = {
    /** The merged continuation signal, or null if no continuation requested. */
    signal: ContinuationSignal | null;
    /** The reason string from a continue_work tool call, if any. */
    workReason?: string;
    /** Whether the signal came from bracket syntax (vs tool call). */
    fromBracket: boolean;
};
/**
 * Extract a continuation signal from the agent's response payloads and/or
 * tool-call request.
 *
 * Priority: bracket-parsed signal takes precedence (it was explicitly in the
 * response text). If no bracket signal, fall back to tool-call request.
 *
 * The bracket signal is stripped from the payload text so the user only sees
 * the conversational reply.
 *
 * @param payloads - The agent's response payload array (text may be mutated to strip signal)
 * @param continueWorkRequest - Tool-call request captured during the turn, if any
 * @param enabled - Whether continuation is enabled in config
 * @param sessionKey - Session key for logging
 */
export declare function extractContinuationSignal(params: {
    payloads: ReplyPayload[];
    continueWorkRequest?: ContinueWorkRequest;
    enabled: boolean;
    sessionKey?: string;
}): ContinuationSignalExtraction;
