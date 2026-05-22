import { o as SessionEntry } from "./types-CTpjYZDk.js";
import { t as ChainState } from "./types-DzQ9PmBx.js";

//#region src/auto-reply/continuation/delegate-dispatch.d.ts
type DelegateDispatchContext = {
  sessionKey: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
};
declare function dispatchToolDelegates(params: {
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
//#endregion
//#region src/auto-reply/continuation/state.d.ts
/**
 * Structural subset of `SessionEntry` covering only the fields the
 * continuation-chain read path needs. Declared independently so callers
 * that want to avoid a static edge into `src/config/sessions/types.js`
 * (notably `subagent-announce.ts` — cycle-avoidance) can satisfy the
 * helper signature without an extra type import.
 */
type ContinuationChainSource = {
  continuationChainCount?: number;
  continuationChainStartedAt?: number;
  continuationChainTokens?: number;
};
/**
 * Read continuation chain state from a SessionEntry with safe defaults.
 *
 * Collapses the scattered `?? 0` / `?? Date.now()` sentinel pattern from
 * 6+ call sites (agent-runner, followup-runner, subagent-announce) into
 * one canonical adapter. The returned ChainState has `turnTokens` folded
 * into `accumulatedChainTokens` so callers don't repeat the addition.
 *
 * - `undefined` source → zeroed chain, `chainStartedAt = Date.now()`
 * - missing `continuationChainStartedAt` → `Date.now()` (the chain appears
 *   to start fresh this turn; matches historical sentinel behavior).
 *
 * Accepts any shape compatible with `ContinuationChainSource`, including
 * `SessionEntry` (structural compatibility).
 */
declare function loadContinuationChainState(source: ContinuationChainSource | undefined, turnTokens?: number): ChainState;
/**
 * Persist continuation chain metadata to the session entry.
 * Called after scheduling to keep chain depth, start time, and token cost
 * in sync with the session store.
 */
declare function persistContinuationChainState(params: {
  sessionEntry?: SessionEntry;
  count: number;
  startedAt: number;
  tokens: number;
}): void;
//#endregion
export { persistContinuationChainState as n, dispatchToolDelegates as r, loadContinuationChainState as t };