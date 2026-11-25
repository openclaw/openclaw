import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RealtimeAudioPacer } from "./realtime-audio-pacer.js";

/**
 * Lines the call asks the model to say are given word for word: realtime models asked for a
 * kind of line ("a warm goodbye") tend to narrate the request aloud instead of saying one.
 */
export function sayExactlyInstructions(line: string): string {
  return [
    "Say exactly the following line and nothing else.",
    "If the conversation is in another language, say the same line in that language instead.",
    "Do not describe what you are doing, do not add anything before or after it, and do not call any tools.",
    `Line: ${line}`,
  ].join(" ");
}

export const REALTIME_IDLE_CHECK_IN_LINE = "Hello? Are you still there?";
export const REALTIME_IDLE_GOODBYE_LINE =
  "Looks like we got disconnected. Feel free to call back anytime. Bye!";

/** Check-ins per call; after the last one, the next silence goes straight to the goodbye. */
const MAX_CHECK_INS = 3;
/** Goodbyes kept open for a caller talking over them, per call; bounds an echo or noise loop. */
const MAX_TALK_OVERS = 2;
/** A goodbye that has not finished playing by then is abandoned and the call ends. */
const GOODBYE_MAX_MS = 10_000;
/** The line stays open this long after the goodbye, so a caller who comes back can answer. */
const GOODBYE_LISTEN_MS = 3_000;
const PLAYOUT_TAIL_MS = 500;
const POLL_MS = 100;

export type IdleCheckIn = ReturnType<typeof createIdleCheckIn>;

/**
 * Speech-idle handling that checks in before hanging up: the first silence gets "are you still
 * there?", and only continued silence gets a goodbye and a hangup once that has played.
 */
export function createIdleCheckIn(params: {
  callId: string;
  providerCallId: string;
  idleHangupMs: number;
  audioPacer: Pick<RealtimeAudioPacer, "hasPlaybackAudio">;
  /** Asks the model to speak next with these instructions; throws when no bridge can. */
  say: (instructions: string) => void;
  isClosed: () => boolean;
  /** Restarts the speech-idle timer, so a line that never plays still leads to the next step. */
  restartIdle: () => void;
  hangUp: () => void;
}) {
  const ids = `callId=${params.callId} providerCallId=${params.providerCallId}`;
  let checkedIn = false;
  let checkIns = 0;
  let talkOvers = 0;
  let sayingGoodbye = false;
  let callerSpeechStarts = 0;
  let audibleOutputs = 0;
  const say = (label: string, line: string): boolean => {
    try {
      params.say(sayExactlyInstructions(line));
      return true;
    } catch (error) {
      console.warn(
        `[voice-call] Realtime idle ${label} failed callId=${params.callId}: ${formatErrorMessage(error)}`,
      );
      return false;
    }
  };
  const sayGoodbye = async (): Promise<void> => {
    sayingGoodbye = true;
    console.warn(
      `[voice-call] Realtime speech idle timeout ${ids} timeoutMs=${params.idleHangupMs}`,
    );
    const speechBefore = callerSpeechStarts;
    const outputBefore = audibleOutputs;
    const deadline = Date.now() + GOODBYE_MAX_MS;
    // Without a bridge to say it, there is no goodbye to wait for.
    let listenUntil = say("goodbye", REALTIME_IDLE_GOODBYE_LINE) ? undefined : Date.now();
    for (;;) {
      if (params.isClosed()) {
        return;
      }
      if (callerSpeechStarts !== speechBefore && talkOvers < MAX_TALK_OVERS) {
        // "Wait, I'm still here": keep the call. The model hears them and answers.
        talkOvers += 1;
        sayingGoodbye = false;
        console.log(`[voice-call] Realtime idle goodbye talked over ${ids}`);
        params.restartIdle();
        return;
      }
      const now = Date.now();
      if (
        listenUntil === undefined &&
        audibleOutputs !== outputBefore &&
        !params.audioPacer.hasPlaybackAudio(PLAYOUT_TAIL_MS)
      ) {
        listenUntil = now + GOODBYE_LISTEN_MS;
      }
      if (listenUntil === undefined ? now >= deadline : now >= listenUntil) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POLL_MS).unref?.();
      });
    }
    params.hangUp();
  };
  return {
    /** The line has been quiet for idleHangupMs. */
    onIdle(this: void) {
      if (sayingGoodbye || params.isClosed()) {
        return;
      }
      if (checkedIn || checkIns >= MAX_CHECK_INS) {
        void sayGoodbye();
        return;
      }
      checkedIn = true;
      checkIns += 1;
      console.log(
        `[voice-call] Realtime speech idle check-in ${ids} timeoutMs=${params.idleHangupMs}`,
      );
      say("check-in", REALTIME_IDLE_CHECK_IN_LINE);
      params.restartIdle();
    },
    /** Detected caller speech, as opposed to any sound on the line, re-arms the check-in. */
    noteCallerSpeech(this: void) {
      checkedIn = false;
      callerSpeechStarts += 1;
    },
    /** Assistant audio was played on the call. */
    noteAudibleOutput(this: void) {
      audibleOutputs += 1;
    },
  };
}
