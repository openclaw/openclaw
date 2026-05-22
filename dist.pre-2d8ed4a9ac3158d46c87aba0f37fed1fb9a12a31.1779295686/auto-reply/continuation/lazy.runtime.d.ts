import { o as SessionEntry } from "../../types-CG0p47bR.js";
import { i as PendingContinuationDelegate } from "../../types-B2cEE3OO.js";
import { t as resolveContinuationRuntimeConfig } from "../../config-V0bCVIOG.js";
import { n as persistContinuationChainState, r as dispatchToolDelegates, t as loadContinuationChainState } from "../../state-n7EIezp2.js";

//#region src/auto-reply/continuation/context-pressure.d.ts
/** Pressure-band percentage returned by {@link resolveContextPressureBand}. */
type PressureBand = number;
interface CheckSessionContextPressureParams {
  sessionEntry: SessionEntry;
  sessionKey: string;
  contextPressureThreshold: number | undefined;
  contextWindowTokens: number;
  earlyWarningBand?: number;
  postCompaction?: boolean;
}
interface CheckTokenContextPressureParams {
  sessionKey: string;
  totalTokens: number;
  contextWindow: number;
  threshold: number;
  earlyWarningBand?: number;
  postCompaction?: boolean;
}
interface CheckContextPressureResult {
  fired: boolean;
  band: PressureBand;
}
/**
 * Check whether a context-pressure event should fire for the given session.
 *
 * Session-entry callers get the reply-pipeline result shape and event enqueueing.
 * Token callers get event text for lifecycle helpers that enqueue separately.
 */
declare function checkContextPressure(params: CheckSessionContextPressureParams): CheckContextPressureResult;
declare function checkContextPressure(params: CheckTokenContextPressureParams): string | null;
/**
 * Clear pressure dedup state for a session. Call after compaction completes
 * so the post-compaction lifecycle can fire fresh bands.
 */
declare function clearContextPressureState(sessionKey: string): void;
//#endregion
//#region src/auto-reply/continuation/delegate-store.d.ts
/**
 * Count pending delegates without consuming them.
 */
declare function pendingDelegateCount(sessionKey: string): number;
/**
 * Consume staged post-compaction delegates. Same lifecycle as consumePendingDelegates.
 */
declare function consumeStagedPostCompactionDelegates(sessionKey: string): PendingContinuationDelegate[];
declare function stagedPostCompactionDelegateCount(sessionKey: string): number;
//#endregion
export { checkContextPressure, clearContextPressureState, consumeStagedPostCompactionDelegates, dispatchToolDelegates, loadContinuationChainState, pendingDelegateCount, persistContinuationChainState, resolveContinuationRuntimeConfig, stagedPostCompactionDelegateCount };