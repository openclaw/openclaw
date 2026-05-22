//#region src/auto-reply/continuation/targeting-pure.d.ts
declare const CONTINUATION_DELEGATE_FANOUT_MODES: readonly ["tree", "all"];
type ContinuationDelegateFanoutMode = (typeof CONTINUATION_DELEGATE_FANOUT_MODES)[number];
type ContinuationCrossSessionTargetingPolicy = "disabled" | "enabled";
//#endregion
//#region src/auto-reply/continuation/types.d.ts
/**
 * A delegate waiting to be dispatched after the current turn completes.
 * Enqueued by the `continue_delegate` tool during execution, consumed by
 * the delegate dispatch module after the response finalizes.
 *
 * `mode` is the single source of truth for silent/silent-wake/post-compaction
 * behaviour. Legacy persisted TaskFlow rows may still carry boolean flags, but
 * runtime objects never do.
 */
type PendingContinuationDelegate = {
  task: string;
  delayMs?: number;
  mode?: "normal" | "silent" | "silent-wake" | "post-compaction";
  firstArmedAt?: number;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: ContinuationDelegateFanoutMode;
  traceparent?: string;
  /**
   * Internal TaskFlow metadata carried from consume → dispatch so downstream
   * spawn/release failures can flip the row from succeeded → failed without
   * re-querying or guessing revision state.
   */
  flowId?: string;
  expectedRevision?: number;
};
/**
 * Resolved continuation configuration. Read from `agents.defaults.continuation`
 * at each enforcement point (hot-reloadable).
 *
 * Note: no `generationGuardTolerance` field. The generation guard mechanism
 * was removed (2026-04-15): unrelated channel noise must not cancel
 * dispatched continuation work.
 */
type ContinuationRuntimeConfig = {
  enabled: boolean;
  defaultDelayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  maxChainLength: number;
  costCapTokens: number;
  maxDelegatesPerTurn: number;
  crossSessionTargeting: ContinuationCrossSessionTargetingPolicy;
  contextPressureThreshold?: number;
  earlyWarningBand?: number;
};
/**
 * Captured by `continue_work()` during tool execution; consumed by the runner
 * in the same turn's post-response. Same-turn ephemeral — never persisted
 * across turn boundaries or gateway restarts.
 *
 * Single canonical definition used by signal extraction, the continue-work
 * tool, and delegate handling.
 */
type ContinueWorkRequest = {
  reason: string;
  delaySeconds: number;
  traceparent?: string;
};
/**
 * Per-session continuation chain state — depth, start time, accumulated tokens.
 * Construct from a `SessionEntry` via `loadContinuationChainState(entry, turnTokens)`
 * in `./state.ts` rather than hand-rolling `?? 0` / `?? Date.now()` at each site.
 */
type ChainState = {
  currentChainCount: number;
  chainStartedAt: number;
  accumulatedChainTokens: number;
};
//#endregion
export { PendingContinuationDelegate as i, ContinuationRuntimeConfig as n, ContinueWorkRequest as r, ChainState as t };