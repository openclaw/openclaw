import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  calculateMulawRms,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import type { CallRecord } from "../types.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import {
  createOutboundGreetingController,
  createRealtimeCallAudioController,
  createRealtimeCallActivityController,
  REALTIME_MEDIA_INACTIVITY_TIMEOUT_MS,
  REALTIME_DISCONNECT_HANGUP_GRACE_MS,
} from "./realtime-call-session-control.js";
import { createRealtimeHostSpeechController } from "./realtime-host-speech.js";
import type { StreamFrameAdapter } from "./stream-frame-adapter.js";

const MAX_REALTIME_WS_BUFFERED_BYTES = 1024 * 1024;

export function createRealtimeCallPlayback(params: {
  ws: WebSocket;
  callRecord: CallRecord;
  callSid: string;
  adapter: StreamFrameAdapter;
  harness: RealtimeVoiceSessionHarness;
  initialGreetingInstructions?: string;
  /** True when the host, not the bridge's ready trigger, decides when the opening is spoken. */
  hostOwnsOpening: boolean;
  holdOpeningMaxMs?: number;
  idleHangupMs?: number;
  getSession: () => RealtimeVoiceBridgeSession | undefined;
  isClosed: () => boolean;
  closeForInactivity: () => void;
}) {
  const { ws, callRecord, callSid, adapter, harness, initialGreetingInstructions } = params;
  const callId = callRecord.callId;
  const sendString = (message: string): boolean => {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (ws.bufferedAmount > MAX_REALTIME_WS_BUFFERED_BYTES) {
      console.warn(
        `[voice-call] realtime outbound websocket backpressure before send callId=${callId} providerCallId=${callSid} bufferedBytes=${ws.bufferedAmount}`,
      );
      ws.close(1013, "Backpressure: send buffer exceeded");
      return false;
    }
    ws.send(message);
    if (ws.bufferedAmount > MAX_REALTIME_WS_BUFFERED_BYTES) {
      console.warn(
        `[voice-call] realtime outbound websocket backpressure after send callId=${callId} providerCallId=${callSid} bufferedBytes=${ws.bufferedAmount}`,
      );
      ws.close(1013, "Backpressure: send buffer exceeded");
      return false;
    }
    return true;
  };
  const pendingMarkAcks = new Map<string, () => void>();
  const audioPacer = new RealtimeAudioPacer({
    // Every pacer reset discards queued marks, so their stored provider
    // acknowledgements can never fire and must be retired with them.
    onPlaybackReset: () => pendingMarkAcks.clear(),
    // Model audio can arrive long before the callee hears it; host speech and the
    // speech-idle timer follow what is actually played out on the call.
    onAudioSent: (audio) => {
      if (calculateMulawRms(audio) >= 0.035) {
        hostSpeech.noteAudibleOutput();
        activity.noteSpeech();
      }
    },
    send: sendString,
    serializer: adapter,
    onBackpressure: () => {
      console.warn(
        `[voice-call] realtime paced audio backpressure callId=${callId} providerCallId=${callSid}`,
      );
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1013, "Backpressure: paced audio queue exceeded");
      }
    },
  });
  const outboundGreeting = createOutboundGreetingController({
    enabled: params.hostOwnsOpening,
    instructions: initialGreetingInstructions,
    call: callRecord,
    holdOpeningMaxMs: params.holdOpeningMaxMs,
    acknowledge: (instructions) => {
      void hostSpeech.speak(instructions).catch((error: unknown) => {
        console.warn("[voice-call] AMD acknowledgement failed:", formatErrorMessage(error));
      });
    },
  });
  const interruptModelOutput = () => {
    params.getSession()?.handleBargeIn({ audioPlaybackActive: true, force: true });
    audioController.cancelOutputAudioForBargeIn("local");
  };
  const hostSpeech = createRealtimeHostSpeechController({
    interrupt: () => {
      interruptModelOutput();
    },
    trigger: (instructions) => {
      const session = params.getSession();
      if (!session) {
        throw new Error("No active realtime bridge for call");
      }
      session.triggerGreeting(instructions);
    },
  });
  const audioController = createRealtimeCallAudioController({
    audioPacer,
    callId,
    harness,
    isOpen: () => !params.isClosed() && ws.readyState === WebSocket.OPEN,
    isBlocked: () => outboundGreeting.isBlocked() && !hostSpeech.isActive(),
    onAudibleOutput: () => {
      outboundGreeting.claim();
    },
    pendingMarkAcks,
    providerCallId: callSid,
  });
  const activity = createRealtimeCallActivityController({
    idleHangupMs: params.idleHangupMs,
    isPaused: () => outboundGreeting.isBlocked() || hostSpeech.isActive(),
    onIdle: () => {
      console.warn(
        `[voice-call] Realtime speech idle timeout callId=${callId} providerCallId=${callSid} timeoutMs=${params.idleHangupMs}`,
      );
      params.closeForInactivity();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Speech inactivity");
      }
    },
    onMediaWarning: () => {
      console.warn(
        `[voice-call] Realtime media inactive callId=${callId} providerCallId=${callSid} timeoutMs=${REALTIME_MEDIA_INACTIVITY_TIMEOUT_MS} graceMs=${REALTIME_DISCONNECT_HANGUP_GRACE_MS}`,
      );
    },
    onMediaTimeout: () => {
      params.closeForInactivity();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Media inactivity");
      }
    },
  });
  return {
    audioPacer,
    pendingMarkAcks,
    outboundGreeting,
    audioController,
    activity,
    hostSpeech,
  };
}
