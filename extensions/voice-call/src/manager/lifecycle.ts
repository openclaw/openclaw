// Voice Call plugin module implements lifecycle behavior.
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { TerminalStates, type CallRecord, type EndReason } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { copyCallRecord, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { clearMaxDurationTimer, rejectTranscriptWaiter } from "./timers.js";

// Shared call finalization path for manager and webhook lifecycle exits.

const log = createSubsystemLogger("voice-call/lifecycle");

type CallLifecycleContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "storePath"
> &
  Partial<
    Pick<CallManagerContext, "transcriptWaiters" | "maxDurationTimers" | "notifyHangupTimers">
  >;

/** Remove a provider-call mapping only when it still points at this call. */
function removeProviderCallMapping(
  providerCallIdMap: Map<string, string>,
  call: Pick<CallRecord, "callId" | "providerCallId">,
): void {
  if (!call.providerCallId) {
    return;
  }
  const mappedCallId = providerCallIdMap.get(call.providerCallId);
  if (mappedCallId === call.callId) {
    providerCallIdMap.delete(call.providerCallId);
  }
}

/** Finalize under the manager mutation queue, publishing cleanup only after persistence. */
export async function finalizeCall(params: {
  ctx: CallLifecycleContext;
  call: CallRecord;
  preparedCall?: CallRecord;
  endReason: EndReason;
  endedAt?: number;
  transcriptRejectReason?: string;
}): Promise<void> {
  const { ctx, call, endReason } = params;
  if (ctx.activeCalls.get(call.callId) !== call) {
    return;
  }
  const previousState = call.state;

  if (!TerminalStates.has(previousState)) {
    const next = copyCallRecord(params.preparedCall ?? call);
    next.endedAt = params.endedAt ?? Date.now();
    next.endReason = endReason;
    transitionState(next, endReason);
    await persistCallRecord(ctx.storePath, next);
    Object.assign(call, next);
    log.info(
      `[voice-call] Call finalized callId=${call.callId} providerCallId=${call.providerCallId ?? "unknown"} endReason=${endReason}`,
    );
  }

  if (ctx.maxDurationTimers) {
    clearMaxDurationTimer({ maxDurationTimers: ctx.maxDurationTimers }, call.callId);
  }
  const notifyTimer = ctx.notifyHangupTimers?.get(call.callId);
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    ctx.notifyHangupTimers?.delete(call.callId);
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
