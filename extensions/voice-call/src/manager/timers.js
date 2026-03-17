import { TerminalStates } from "../types.js";
import { persistCallRecord } from "./store.js";
function clearMaxDurationTimer(ctx, callId) {
  const timer = ctx.maxDurationTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ctx.maxDurationTimers.delete(callId);
  }
}
function startMaxDurationTimer(params) {
  clearMaxDurationTimer(params.ctx, params.callId);
  const maxDurationMs = params.ctx.config.maxDurationSeconds * 1e3;
  console.log(
    `[voice-call] Starting max duration timer (${params.ctx.config.maxDurationSeconds}s) for call ${params.callId}`
  );
  const timer = setTimeout(async () => {
    params.ctx.maxDurationTimers.delete(params.callId);
    const call = params.ctx.activeCalls.get(params.callId);
    if (call && !TerminalStates.has(call.state)) {
      console.log(
        `[voice-call] Max duration reached (${params.ctx.config.maxDurationSeconds}s), ending call ${params.callId}`
      );
      call.endReason = "timeout";
      persistCallRecord(params.ctx.storePath, call);
      await params.onTimeout(params.callId);
    }
  }, maxDurationMs);
  params.ctx.maxDurationTimers.set(params.callId, timer);
}
function clearTranscriptWaiter(ctx, callId) {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timeout);
  ctx.transcriptWaiters.delete(callId);
}
function rejectTranscriptWaiter(ctx, callId, reason) {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return;
  }
  clearTranscriptWaiter(ctx, callId);
  waiter.reject(new Error(reason));
}
function resolveTranscriptWaiter(ctx, callId, transcript, turnToken) {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return false;
  }
  if (waiter.turnToken && waiter.turnToken !== turnToken) {
    return false;
  }
  clearTranscriptWaiter(ctx, callId);
  waiter.resolve(transcript);
  return true;
}
function waitForFinalTranscript(ctx, callId, turnToken) {
  if (ctx.transcriptWaiters.has(callId)) {
    return Promise.reject(new Error("Already waiting for transcript"));
  }
  const timeoutMs = ctx.config.transcriptTimeoutMs;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ctx.transcriptWaiters.delete(callId);
      reject(new Error(`Timed out waiting for transcript after ${timeoutMs}ms`));
    }, timeoutMs);
    ctx.transcriptWaiters.set(callId, { resolve, reject, timeout, turnToken });
  });
}
export {
  clearMaxDurationTimer,
  clearTranscriptWaiter,
  rejectTranscriptWaiter,
  resolveTranscriptWaiter,
  startMaxDurationTimer,
  waitForFinalTranscript
};
