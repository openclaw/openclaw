import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRealtimeVoiceSpeakExactMessage,
  type RealtimeVoiceAudioSink,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import type { RealtimeAudioPacer } from "./realtime-audio-pacer.js";

const OUTBOUND_GREETING_FALLBACK_MS = 3_000;

export type RealtimeCallControlResult = {
  success: boolean;
  error?: string;
};

export function speakOnRealtimeBridge(
  bridges: ReadonlyMap<string, Pick<RealtimeVoiceBridgeSession, "triggerGreeting">>,
  callId: string,
  instructions: string,
): RealtimeCallControlResult {
  const bridge = bridges.get(callId);
  if (!bridge) {
    return { success: false, error: "No active realtime bridge for call" };
  }
  try {
    bridge.triggerGreeting(instructions);
    return { success: true };
  } catch (error) {
    return { success: false, error: formatErrorMessage(error) };
  }
}

export function buildGreetingInstructions(
  baseInstructions: string | undefined,
  greeting: string | undefined,
): string | undefined {
  const trimmedGreeting = greeting?.trim();
  if (!trimmedGreeting) {
    return undefined;
  }
  const intro =
    "Start the call by greeting the caller naturally. Include this greeting in your first spoken reply:";
  return baseInstructions
    ? `${baseInstructions}\n\n${intro} "${trimmedGreeting}"`
    : `${intro} "${trimmedGreeting}"`;
}

export function buildVerbatimGreetingInstructions(
  baseInstructions: string | undefined,
  greeting: string | undefined,
): string | undefined {
  const trimmedGreeting = greeting?.trim();
  if (!trimmedGreeting) {
    return undefined;
  }
  const exactGreeting = [
    "For your first spoken reply, the first words must be the exact Answer below, verbatim and in its original language, with nothing before or after it.",
    "Then stop and listen.",
    buildRealtimeVoiceSpeakExactMessage({ text: trimmedGreeting, surfaceLabel: "the callee" }),
  ].join("\n");
  return baseInstructions ? `${baseInstructions}\n\n${exactGreeting}` : exactGreeting;
}

export function createOutboundGreetingController(params: {
  enabled: boolean;
  instructions?: string;
  fallbackMs?: number;
}) {
  let claimed = !params.enabled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const claim = () => {
    if (claimed) {
      return false;
    }
    claimed = true;
    clearTimer();
    return true;
  };
  return {
    claim,
    close: clearTimer,
    onReady(session: RealtimeVoiceBridgeSession) {
      if (!params.enabled || !params.instructions || claimed) {
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        if (claim()) {
          session.triggerGreeting(params.instructions);
        }
      }, params.fallbackMs ?? OUTBOUND_GREETING_FALLBACK_MS);
      timer.unref?.();
    },
  };
}

export function createRealtimeCallActivityController(params: {
  idleHangupMs?: number;
  mediaInactivityMs: number;
  mediaGraceMs: number;
  onIdle: () => void;
  onMediaWarning: () => void;
  onMediaTimeout: () => void;
}) {
  let closed = false;
  let started = false;
  let consultsInFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let mediaTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const clearMedia = () => {
    if (mediaTimer) {
      clearTimeout(mediaTimer);
      mediaTimer = undefined;
    }
  };
  const resetIdle = () => {
    clearIdle();
    if (closed || !started || !params.idleHangupMs || consultsInFlight > 0) {
      return;
    }
    idleTimer = setTimeout(params.onIdle, params.idleHangupMs);
    idleTimer.unref?.();
  };
  return {
    beginConsult() {
      consultsInFlight += 1;
      clearIdle();
    },
    close() {
      closed = true;
      clearIdle();
      clearMedia();
    },
    endConsult() {
      consultsInFlight = Math.max(0, consultsInFlight - 1);
      if (consultsInFlight === 0) {
        resetIdle();
      }
    },
    isPaused: () => consultsInFlight > 0,
    noteMedia() {
      if (closed) {
        return;
      }
      clearMedia();
      mediaTimer = setTimeout(() => {
        params.onMediaWarning();
        mediaTimer = setTimeout(params.onMediaTimeout, params.mediaGraceMs);
        mediaTimer.unref?.();
      }, params.mediaInactivityMs);
      mediaTimer.unref?.();
    },
    noteSpeech: resetIdle,
    start() {
      started = true;
      resetIdle();
    },
  };
}

export function createRealtimeCallAudioController(params: {
  audioPacer: RealtimeAudioPacer;
  callId: string;
  harness: RealtimeVoiceSessionHarness;
  isOpen: () => boolean;
  pendingMarkAcks: Map<string, () => void>;
  providerCallId: string;
}) {
  const cancelOutputAudioForBargeIn = (
    source: "local" | "provider",
    interruptProvider?: (audioPlaybackActive: boolean) => void,
    clearedAudioBytes = 0,
  ): void => {
    const outputAudioActive = params.harness.talk.outputAudioActive;
    const pendingTelephonyAudio = params.audioPacer.hasPendingAudio();
    if (
      source === "provider" &&
      !outputAudioActive &&
      !pendingTelephonyAudio &&
      clearedAudioBytes === 0
    ) {
      return;
    }
    const interruptedTurnId = params.harness.talk.activeTurnId;
    if (outputAudioActive || pendingTelephonyAudio) {
      interruptProvider?.(true);
    }
    const shouldClearTelephony = source === "local" || pendingTelephonyAudio;
    const clearedBytes =
      clearedAudioBytes + (shouldClearTelephony ? params.audioPacer.clearAudio() : 0);
    console.log(
      `[voice-call] realtime outbound audio cleared by ${source} barge-in callId=${params.callId} providerCallId=${params.providerCallId} queuedBytes=${clearedBytes}`,
    );
    if (!outputAudioActive || !interruptedTurnId) {
      return;
    }
    const reason = `${source}-barge-in`;
    params.harness.finishOutputAudio(reason);
    params.harness.talk.cancelTurn({
      turnId: interruptedTurnId,
      payload: { callId: params.callId, providerCallId: params.providerCallId, reason },
    });
  };
  const audioSink: RealtimeVoiceAudioSink = {
    isOpen: params.isOpen,
    sendAudio: (muLaw, metadata) => {
      params.harness.recordOutputAudio(muLaw);
      params.audioPacer.sendAudio(muLaw, metadata);
    },
    getPlaybackState: () => params.audioPacer.getPlaybackState(),
    clearAudio: (reason) => {
      params.harness.flushOutput(() => {
        const clearedBytes = params.audioPacer.clearAudio();
        if (reason === "barge-in") {
          cancelOutputAudioForBargeIn("provider", undefined, clearedBytes);
          return;
        }
        console.log(
          `[voice-call] realtime outbound audio clear requested callId=${params.callId} providerCallId=${params.providerCallId} queuedBytes=${clearedBytes}`,
        );
        params.harness.finishOutputAudio(reason ?? "clear");
      });
    },
    sendMark: (markName, acknowledge) => {
      params.audioPacer.sendMark(markName);
      if (markName && acknowledge) {
        params.pendingMarkAcks.set(markName, acknowledge);
      }
    },
  };
  return { audioSink, cancelOutputAudioForBargeIn };
}
