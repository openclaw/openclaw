import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceBridgeSession } from "openclaw/plugin-sdk/realtime-voice";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import type { CallManager } from "../manager.js";
import type { EndReason } from "../types.js";
import type { createRealtimeCallPlayback } from "./realtime-call-playback.js";
import type {
  RealtimeCallEndCause,
  RealtimeMediaTransport,
  RealtimeRoomBinding,
  RealtimeTelephonyBinding,
} from "./realtime-call-transport.js";
import type { StreamDisconnectGrace } from "./stream-disconnect-grace.js";

type RealtimeCallPlayback = ReturnType<typeof createRealtimeCallPlayback>;

/** Bind one admitted provider session to its carrier and current call-map authority. */
export function createRealtimeTelephonyBinding(params: {
  session: RealtimeVoiceBridgeSession;
  ws: RealtimeMediaTransport;
  callId: string;
  callSid: string;
  streamSid: string;
  activity: RealtimeCallPlayback["activity"];
  audioPacer: RealtimeCallPlayback["audioPacer"];
  pendingMarkAcks: RealtimeCallPlayback["pendingMarkAcks"];
  hostSpeech: RealtimeCallPlayback["hostSpeech"];
  activeBridgesByCallId: Map<string, RealtimeVoiceBridgeSession>;
  activeBindingsByCallId: Map<string, RealtimeTelephonyBinding>;
  streamDisconnectLifecycle: StreamDisconnectGrace;
  previousBinding?: RealtimeTelephonyBinding;
  idleHangupMs?: number;
  emitCallEnd: (cause: RealtimeCallEndCause) => Promise<void>;
  trackTermination: (work: Promise<void>) => void;
}): RealtimeTelephonyBinding {
  const {
    session,
    ws,
    callId,
    callSid,
    streamSid,
    activity,
    audioPacer,
    pendingMarkAcks,
    hostSpeech,
    activeBridgesByCallId,
    activeBindingsByCallId,
    streamDisconnectLifecycle,
    emitCallEnd,
  } = params;
  let bindingClosed = false;
  let bindingClosePromise: Promise<void> | undefined;
  let bindingCompletionPromise: Promise<void> | undefined;
  const closeBinding = (cause?: RealtimeCallEndCause): Promise<void> => {
    if (bindingClosed) {
      return (cause ? bindingCompletionPromise : bindingClosePromise) ?? Promise.resolve();
    }
    bindingClosed = true;
    activity.close();
    const ownsCall = activeBindingsByCallId.get(callId) === telephonyBinding;
    const finishClose = () => {
      const stillOwnsCall = activeBindingsByCallId.get(callId) === telephonyBinding;
      if (stillOwnsCall) {
        activeBindingsByCallId.delete(callId);
      }
      if (cause === "disconnect") {
        streamDisconnectLifecycle.disconnect(callSid, streamSid);
      } else {
        streamDisconnectLifecycle.retire(callSid, streamSid);
      }
      return ownsCall && stillOwnsCall;
    };
    const providerDisposal = createDeferred<void>();
    const pending = providerDisposal.promise;
    // The disposal promise excludes manager termination: hangupCall can reenter
    // endCall while the outer close is waiting for manager.endCall.
    let shouldEndCall = false;
    bindingClosePromise = pending.then(
      () => {
        shouldEndCall = finishClose();
      },
      (error: unknown) => {
        shouldEndCall = finishClose();
        throw error;
      },
    );
    const terminate = () =>
      shouldEndCall && cause && cause !== "disconnect" ? emitCallEnd(cause) : Promise.resolve();
    const completion = bindingClosePromise.then(terminate, async (error: unknown) => {
      console.warn(
        `[voice-call] Failed to close realtime bridge ${callSid}: ${formatErrorMessage(error)}`,
      );
      try {
        await terminate();
      } catch (terminationError) {
        throw new AggregateError([error, terminationError], "Realtime call cleanup failed", {
          cause: terminationError,
        });
      }
      throw error;
    });
    bindingCompletionPromise = completion;
    params.trackTermination(completion);
    // Publish both promises before provider.close can synchronously close the
    // carrier and reenter this binding through manager.hangupCall.
    try {
      void Promise.resolve(session.close()).then(providerDisposal.resolve, providerDisposal.reject);
    } catch (error) {
      providerDisposal.reject(error);
    }
    return cause ? completion : bindingClosePromise;
  };
  const telephonyBinding: RealtimeTelephonyBinding = {
    bridge: session,
    acknowledgeCarrierMark: (markName) => {
      // Retire the played prefix before provider acknowledgement so any
      // truncation snapshot no longer carries carrier-confirmed items.
      audioPacer.acknowledgeMark(markName);
      if (!markName) {
        return;
      }
      const acknowledge = pendingMarkAcks.get(markName);
      if (acknowledge) {
        pendingMarkAcks.delete(markName);
        acknowledge();
      }
    },
    close: (cause) => closeBinding(cause),
    endCall: () => {
      // Close the provider session before the carrier socket so no pending
      // response can reach the caller after the hang-up request succeeds.
      const disposal = closeBinding();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Call ended");
      }
      return disposal;
    },
    noteMediaActivity: () => activity.noteMedia(),
    playVoicemail: (speechInstructions) => hostSpeech.speak(speechInstructions),
    retire: () => {
      void closeBinding();
    },
  };
  activeBridgesByCallId.set(callId, session);
  activeBridgesByCallId.set(callSid, session);
  activeBindingsByCallId.set(callId, telephonyBinding);
  telephonyBinding.noteMediaActivity();
  activity.start();
  if (params.idleHangupMs) {
    console.log(
      `[voice-call] Realtime speech idle monitor armed callId=${callId} providerCallId=${callSid} timeoutMs=${params.idleHangupMs}`,
    );
  }
  if (params.previousBinding && params.previousBinding !== telephonyBinding) {
    params.previousBinding.retire();
  }

  return telephonyBinding;
}

/** Join RTC admission without including manager termination in carrier-owned disposal. */
export async function attachRealtimeRoomTransport(params: {
  isClosing: () => boolean;
  admit: () => Promise<RealtimeTelephonyBinding | null>;
  trackAdmission: (work: Promise<void>) => void;
  roomBindings: Set<RealtimeTelephonyBinding>;
}): Promise<RealtimeRoomBinding | null> {
  if (params.isClosing()) {
    return null;
  }
  const admission = params.admit();
  params.trackAdmission(admission.then(() => {}));
  const admitted = await admission;
  if (!admitted) {
    return null;
  }
  if (params.isClosing()) {
    // RTC admission still belongs to the carrier join. Terminating the manager
    // here would await hangupCall, which must itself join this admission.
    void admitted.close("shutdown").catch(() => {});
    await admitted.endCall();
    return null;
  }
  params.roomBindings.add(admitted);
  return {
    sendAudio: (audio) => {
      admitted.noteMediaActivity();
      admitted.bridge.sendAudio(audio);
    },
    endCall: () => {
      params.roomBindings.delete(admitted);
      return admitted.endCall();
    },
    acknowledgeMark: (name) => admitted.acknowledgeCarrierMark(name),
  };
}

/** Share the manager-owned terminal attempt across provider and carrier close paths. */
export function createRealtimeCallTermination(params: {
  manager: Pick<CallManager, "endCall">;
  callId: string;
  callSid: string;
  trackTermination: (work: Promise<void>) => void;
}): (cause: RealtimeCallEndCause) => Promise<void> {
  const { callId, callSid } = params;
  let callEndPromise: Promise<void> | undefined;
  const emitCallEnd = (cause: RealtimeCallEndCause): Promise<void> => {
    if (callEndPromise) {
      return callEndPromise;
    }
    const reason: EndReason =
      cause === "error" ? "error" : cause === "inactivity" ? "timeout" : "completed";
    const attempt = params.manager.endCall(callId, { reason }).then((result) => {
      if (!result.success) {
        console.warn(
          `[voice-call] Failed to end realtime call callId=${callId} providerCallId=${callSid} reason=${reason}: ${result.error ?? "unknown error"}; call remains active`,
        );
        return;
      }
      console.log(
        `[voice-call] Realtime call ended callId=${callId} providerCallId=${callSid} reason=${cause}`,
      );
    });
    callEndPromise = attempt;
    params.trackTermination(attempt);
    return attempt;
  };

  return emitCallEnd;
}

/** Publish disposal before a provider can synchronously reenter carrier hangup. */
export function bindRealtimeSessionDisposal(params: {
  session: RealtimeVoiceBridgeSession;
  callId: string;
  callSid: string;
  activeBridgesByCallId: Map<string, RealtimeVoiceBridgeSession>;
  drainProviderClose: (closeProvider: () => void | Promise<void>) => Promise<void>;
  isClosed: () => boolean;
  onClosing: () => void;
  onClosed: () => void;
}): void {
  const { session, activeBridgesByCallId, callId, callSid } = params;
  const closeSession = session.close.bind(session);
  let sessionClosePromise: Promise<void> | undefined;
  session.close = (): Promise<void> => {
    if (params.isClosed()) {
      return sessionClosePromise ?? Promise.resolve();
    }
    params.onClosing();
    const completion = createDeferred<void>();
    sessionClosePromise = completion.promise;
    const work = params.drainProviderClose(closeSession).finally(() => {
      for (const key of [callId, callSid]) {
        if (activeBridgesByCallId.get(key) === session) {
          activeBridgesByCallId.delete(key);
        }
      }
      params.onClosed();
    });
    void work.then(completion.resolve, completion.reject);
    return sessionClosePromise;
  };
}
