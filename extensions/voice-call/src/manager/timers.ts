import { TerminalStates, type CallId } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { persistCallRecord } from "./store.js";
import {
  resolveVoiceCallSecondsTimerDelayMs,
  resolveVoiceCallTimerDelayMs,
} from "./timer-delays.js";

type TimerContext = Pick<
  CallManagerContext,
  "activeCalls" | "maxDurationTimers" | "config" | "storePath" | "transcriptWaiters"
>;
type MaxDurationTimerContext = Pick<
  TimerContext,
  "activeCalls" | "maxDurationTimers" | "config" | "storePath"
>;
type TranscriptWaiterContext = Pick<TimerContext, "transcriptWaiters">;

/** Cancels and forgets the max-duration timer for one call. */
export function clearMaxDurationTimer(
  ctx: Pick<MaxDurationTimerContext, "maxDurationTimers">,
  callId: CallId,
): void {
  const timer = ctx.maxDurationTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ctx.maxDurationTimers.delete(callId);
  }
}

/** Starts the per-call hard timeout, replacing any previous timer for the same call. */
export function startMaxDurationTimer(params: {
  /** Manager maps/config used to find the live call and persist timeout metadata. */
  ctx: MaxDurationTimerContext;
  /** Internal call id whose timer should be replaced and tracked. */
  callId: CallId;
  /** Cleanup hook invoked after timeout metadata is persisted on the live call. */
  onTimeout: (callId: CallId) => Promise<void>;
  /** Optional millisecond override used when restoring aged calls. */
  timeoutMs?: number;
}): void {
  clearMaxDurationTimer(params.ctx, params.callId);

  const maxDurationMs =
    params.timeoutMs === undefined
      ? resolveVoiceCallSecondsTimerDelayMs(params.ctx.config.maxDurationSeconds)
      : resolveVoiceCallTimerDelayMs(params.timeoutMs);
  console.log(
    `[voice-call] Starting max duration timer (${Math.ceil(maxDurationMs / 1000)}s) for call ${params.callId}`,
  );

  const timer = setTimeout(() => {
    void (async () => {
      params.ctx.maxDurationTimers.delete(params.callId);
      const call = params.ctx.activeCalls.get(params.callId);
      if (call && !TerminalStates.has(call.state)) {
        console.log(
          `[voice-call] Max duration reached (${Math.ceil(maxDurationMs / 1000)}s), ending call ${params.callId}`,
        );
        call.endReason = "timeout";
        // Persist the timeout reason before delegating to provider hangup/cleanup.
        persistCallRecord(params.ctx.storePath, call);
        await params.onTimeout(params.callId);
      }
    })();
  }, maxDurationMs);

  params.ctx.maxDurationTimers.set(params.callId, timer);
}

/** Clears a pending final-transcript waiter without resolving or rejecting its promise. */
export function clearTranscriptWaiter(ctx: TranscriptWaiterContext, callId: CallId): void {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timeout);
  ctx.transcriptWaiters.delete(callId);
}

/** Rejects and removes the pending final-transcript waiter for a call. */
export function rejectTranscriptWaiter(
  ctx: TranscriptWaiterContext,
  callId: CallId,
  reason: string,
): void {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return;
  }
  clearTranscriptWaiter(ctx, callId);
  waiter.reject(new Error(reason));
}

/** Resolves a pending transcript waiter only when its optional turn token matches. */
export function resolveTranscriptWaiter(
  ctx: TranscriptWaiterContext,
  callId: CallId,
  transcript: string,
  turnToken?: string,
): boolean {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return false;
  }
  if (waiter.turnToken && waiter.turnToken !== turnToken) {
    // Ignore stale transcript completions from an earlier turn on the same call.
    return false;
  }
  clearTranscriptWaiter(ctx, callId);
  waiter.resolve(transcript);
  return true;
}

/** Registers a single pending final-transcript wait for a call turn. */
export function waitForFinalTranscript(
  ctx: TimerContext,
  /** Internal call id; only one waiter may be active per call. */
  callId: CallId,
  /** Optional provider turn token that filters stale final transcripts. */
  turnToken?: string,
): Promise<string> {
  if (ctx.transcriptWaiters.has(callId)) {
    return Promise.reject(new Error("Already waiting for transcript"));
  }

  const timeoutMs = resolveVoiceCallTimerDelayMs(ctx.config.transcriptTimeoutMs);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ctx.transcriptWaiters.delete(callId);
      reject(new Error(`Timed out waiting for transcript after ${timeoutMs}ms`));
    }, timeoutMs);

    ctx.transcriptWaiters.set(callId, { resolve, reject, timeout, turnToken });
  });
}
