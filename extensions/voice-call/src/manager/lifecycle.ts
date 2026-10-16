import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { TerminalStates, type CallRecord, type EndReason } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { copyCallRecord, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { clearMaxDurationTimer, rejectTranscriptWaiter } from "./timers.js";

const log = createSubsystemLogger("voice-call/lifecycle");

type CallLifecycleContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "onCallUpdated"
  | "providerCallIdMap"
  | "storePath"
  | "stateRuntime"
  | "transcriptWaiters"
  | "maxDurationTimers"
  | "notifyHangupTimers"
>;

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
  if (!TerminalStates.has(call.state)) {
    const next = copyCallRecord(params.preparedCall ?? call);
    next.endedAt = params.endedAt ?? Date.now();
    next.endReason = endReason;
    transitionState(next, endReason);
    await persistCallRecord(ctx.storePath, next, ctx.stateRuntime);
    Object.assign(call, next);
    log.info(
      `[voice-call] Call finalized callId=${call.callId} providerCallId=${call.providerCallId ?? "unknown"} endReason=${endReason}`,
    );
  }

  clearMaxDurationTimer(ctx, call.callId);
  const notifyTimer = ctx.notifyHangupTimers.get(call.callId);
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    ctx.notifyHangupTimers.delete(call.callId);
  }
  rejectTranscriptWaiter(
    ctx,
    call.callId,
    params.transcriptRejectReason ?? `Call ended: ${endReason}`,
  );

  ctx.activeCalls.delete(call.callId);
  // Remove a provider-call mapping only when it still points at this call.
  if (call.providerCallId && ctx.providerCallIdMap.get(call.providerCallId) === call.callId) {
    ctx.providerCallIdMap.delete(call.providerCallId);
  }
  void ctx.onCallUpdated?.(call);
}
