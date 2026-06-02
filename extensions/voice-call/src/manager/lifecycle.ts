import type { CallRecord, EndReason } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { clearMaxDurationTimer, rejectTranscriptWaiter } from "./timers.js";

type CallLifecycleContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "storePath"
> &
  Partial<Pick<CallManagerContext, "transcriptWaiters" | "maxDurationTimers">>;

function removeProviderCallMapping(
  providerCallIdMap: Map<string, string>,
  call: Pick<CallRecord, "callId" | "providerCallId">,
): void {
  if (!call.providerCallId) {
    return;
  }
  const mappedCallId = providerCallIdMap.get(call.providerCallId);
  // Webhook repair can adopt or replace provider ids while stale call records
  // are still finalizing; only the call that owns the live map entry may delete it.
  if (mappedCallId === call.callId) {
    providerCallIdMap.delete(call.providerCallId);
  }
}

/** Finalizes one call record, persists it, and clears transient timers/waiters. */
export function finalizeCall(params: {
  /** Manager state maps and optional transient queues that own this call. */
  ctx: CallLifecycleContext;
  /** Active call record to mark terminal and remove from live indexes. */
  call: CallRecord;
  /** Terminal reason that also drives the call-state transition. */
  endReason: EndReason;
  /** Provider event timestamp; defaults to local wall time for local hangups. */
  endedAt?: number;
  /** Optional waiter error text when a pending transcript promise must be rejected. */
  transcriptRejectReason?: string;
}): void {
  const { ctx, call, endReason } = params;

  call.endedAt = params.endedAt ?? Date.now();
  call.endReason = endReason;
  transitionState(call, endReason);
  persistCallRecord(ctx.storePath, call);

  // Timers and waiters are process-local state; clear them before dropping the
  // active call so late timeout/transcript callbacks cannot observe a dead call.
  if (ctx.maxDurationTimers) {
    clearMaxDurationTimer({ maxDurationTimers: ctx.maxDurationTimers }, call.callId);
  }
  if (ctx.transcriptWaiters) {
    rejectTranscriptWaiter(
      { transcriptWaiters: ctx.transcriptWaiters },
      call.callId,
      params.transcriptRejectReason ?? `Call ended: ${endReason}`,
    );
  }

  ctx.activeCalls.delete(call.callId);
  removeProviderCallMapping(ctx.providerCallIdMap, call);
}
