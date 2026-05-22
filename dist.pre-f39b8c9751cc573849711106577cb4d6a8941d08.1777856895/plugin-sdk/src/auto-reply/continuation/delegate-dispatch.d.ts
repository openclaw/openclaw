/**
 * Continuation delegate dispatch — spawn logic for both immediate and delayed delegates.
 *
 * Consumes pending delegates from the store and dispatches them via spawnSubagentDirect.
 * Handles per-turn cap enforcement, chain-hop prefix, and mode flags.
 *
 * OBSERVABILITY: every spawn outcome (accepted/rejected/failed) is logged at info level,
 * regardless of whether the spawn was immediate or timer-triggered. The old branch gated
 * success logging behind `timerTriggered`, making immediate delegates invisible to operators.
 * Do not reproduce this.
 *
 * RFC: docs/design/continue-work-signal-v2.md §3.2, §3.4
 */
import { type ChainState } from "./scheduler.js";
/**
 * Test-only: cancel any pending hedge timers and clear the registry.
 */
export declare function resetDelegateDispatchHedgesForTests(): void;
export type DelegateDispatchContext = {
    sessionKey: string;
    agentChannel?: string;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
};
/**
 * Consume and dispatch all pending tool-dispatched delegates for a session.
 *
 * Called by agent-runner.ts after the response finalizes.
 * Each delegate goes through chain/cost enforcement and is spawned via spawnSubagentDirect.
 */
export declare function dispatchToolDelegates(params: {
    sessionKey: string;
    chainState: ChainState;
    ctx: DelegateDispatchContext;
    maxChainLength: number;
    /**
     * Optional callback the hedge timer invokes to re-load the chain state
     * from the persisted session entry at fire time, so the re-dispatch sees
     * any chain-count advancement that happened while the timer was pending.
     * Without this the hedge captures a stale `chainState` snapshot and may
     * dispatch past `maxChainLength`.
     */
    loadFreshChainState?: () => ChainState;
}): Promise<{
    dispatched: number;
    rejected: number;
    chainState: ChainState;
}>;
export interface PostCompactionSpawnContext {
    agentSessionKey: string;
    agentChannel?: string;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
}
/**
 * Dispatch post-compaction delegates with silentAnnounce + wakeOnReturn.
 *
 * This mirrors dispatchToolDelegates but is specifically for post-compaction
 * staged delegates. Errors are logged and surfaced as system events rather
 * than silently swallowed.
 */
export declare function dispatchStagedPostCompactionDelegates(delegates: Array<{
    task: string;
}>, sessionKey: string, spawnCtx: PostCompactionSpawnContext): Promise<{
    dispatched: number;
    failed: number;
}>;
