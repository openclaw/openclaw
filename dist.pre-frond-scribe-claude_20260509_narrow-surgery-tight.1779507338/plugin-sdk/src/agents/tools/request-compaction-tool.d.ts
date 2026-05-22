import { enqueueSystemEvent } from "../../infra/system-events.js";
import { type RequestCompactionInvocation } from "../compaction-attribution.js";
import type { AnyAgentTool } from "./common.js";
export type RequestCompactionToolOpts = {
    /** Current session key (e.g. "telegram:12345"). */
    agentSessionKey?: string;
    /** Session id (the Pi session UUID). */
    sessionId?: string;
    /** Stable run identifier for this agent invocation. */
    runId?: string;
    /**
     * Returns the current context usage as a fraction (0-1), or null when unknown
     * (e.g. inventory-only path used by /status surface reflection).
     * Injected so the tool does not reach into session internals.
     */
    getContextUsage: () => number | null;
    /**
     * Async function that triggers compaction. Injected so the tool does not
     * import the heavy compaction module directly. The caller provides a
     * closure over `compactEmbeddedPiSession` with all required session params.
     */
    triggerCompaction: (request: RequestCompactionInvocation) => Promise<{
        ok: boolean;
        compacted: boolean;
        reason?: string;
    }>;
    enqueueSystemEvent?: typeof enqueueSystemEvent;
};
/**
 * Creates the `request_compaction` tool.
 *
 * This tool allows the agent to **request** compaction after it has prepared —
 * evacuated working state to memory files, staged post-compaction delegates,
 * or otherwise accepted the context loss.
 *
 * The tool is ASYNC: it enqueues compaction and returns immediately. The
 * compaction runs between turns via the lane queue, not during the tool call.
 *
 * Guards (all checked before compaction is enqueued):
 *   - **Dedup:** a compaction request is not already pending for this session.
 *   - **Context threshold:** context usage must be >= 70%.
 *   - **Rate limit:** at most one compaction per 5 minutes per session.
 *
 * (The earlier "generation guard" was removed 2026-04-15 by RFC: compaction
 * is no longer blocked by mid-turn message arrival because the lane queue
 * already serializes compaction relative to subsequent messages.)
 */
export declare function createRequestCompactionTool(opts: RequestCompactionToolOpts): AnyAgentTool;
/** Increment the volitional compaction counter for a session. */
export declare function incrementVolitionalCompactionCount(sessionKey: string): void;
/** Get the volitional compaction count for a session. */
export declare function getVolitionalCompactionCount(sessionKey: string): number;
/** Reset per-session guard state. Exported for tests only. */
export declare function _resetGuardState(sessionKey?: string): void;
/** Mark a session as having a pending compaction. Exported for tests only. */
export declare function _setPending(sessionKey: string): void;
/** Check whether a session has a pending compaction. Exported for tests only. */
export declare function hasPendingCompactionSession(sessionKey: string): boolean;
/** Reset volitional compaction counters. Exported for tests only. */
export declare function _resetVolitionalCounts(sessionKey?: string): void;
/** Expose constants for test assertions. */
export declare const _guards: {
    readonly MIN_CONTEXT_THRESHOLD: 0.7;
    readonly RATE_LIMIT_MS: number;
    readonly VOLITIONAL_COMPACTION_COUNT_TTL_MS: number;
};
