import { randomUUID } from "node:crypto";
import {
  buildRealtimeVoiceSpeakExactMessage,
  type RealtimeVoiceResponseOutcome,
  type RealtimeVoiceBridgeSession,
} from "openclaw/plugin-sdk/realtime-voice";

// Bound each generation rather than enlarging the paced-audio queue. A passage is
// deliberately much shorter than the queue's two minutes of telephony audio.
const PASSAGE_CHARACTERS = 480;

function createRealtimeReading(params: {
  text: string;
  instructions?: string;
  speak: (instructions: string) => void;
  afterPlayback: (mark: string, acknowledge: () => void) => void;
}) {
  if (params.text.length <= PASSAGE_CHARACTERS) {
    return undefined;
  }
  const passages: string[] = [];
  let remaining = params.text;
  while (remaining.length > PASSAGE_CHARACTERS) {
    let end = remaining.lastIndexOf(" ", PASSAGE_CHARACTERS);
    if (end <= 0) {
      end = PASSAGE_CHARACTERS;
      // Do not split a surrogate pair in a long unbroken word.
      if (/^[\uDC00-\uDFFF]$/u.test(remaining[end] ?? "")) {
        end -= 1;
      }
    } else {
      end += 1;
    }
    passages.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  passages.push(remaining);
  const prefix = `openclaw-reading-${randomUUID()}`;
  let index = 0;
  let phase: "ready" | "generating" | "playing" | "stopped" = "ready";
  const cancel = () => {
    phase = "stopped";
  };
  const speak = () => {
    phase = "generating";
    params.speak(
      [
        params.instructions,
        "Read only this passage verbatim, in its original language. Do not add a greeting, summary, or closing. Stop after this passage; the host will supply the next passage after playback.",
        buildRealtimeVoiceSpeakExactMessage({
          text: passages[index] ?? "",
          surfaceLabel: "the callee",
        }),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  };
  return {
    start() {
      if (phase === "ready") {
        speak();
      }
    },
    cancel,
    isActive: () => phase === "generating" || phase === "playing",
    interrupt() {
      if (phase !== "ready") {
        cancel();
      }
    },
    responseDone(outcome: RealtimeVoiceResponseOutcome) {
      if (phase !== "generating") {
        return;
      }
      if (outcome.status !== "completed") {
        cancel();
        return;
      }
      phase = "playing";
      const completedIndex = index;
      params.afterPlayback(`${prefix}-${index}`, () => {
        if (phase !== "playing" || index !== completedIndex) {
          return;
        }
        index += 1;
        if (index === passages.length) {
          cancel();
        } else {
          speak();
        }
      });
    },
  };
}

export function attachRealtimeReading(params: {
  session: RealtimeVoiceBridgeSession;
  text: string | undefined;
  instructions: string;
  initialGreetingInstructions: string | undefined;
  handlesAgentConsult: boolean;
  afterPlayback: (mark: string, acknowledge: () => void) => void;
}) {
  const { session, text } = params;
  // Continuous/native-delegation providers do not expose response completion;
  // retain their existing opening path rather than silently dropping passages.
  if (!text || params.handlesAgentConsult || session.bridge.outputAudioMode === "continuous") {
    return undefined;
  }
  const triggerGreeting = session.triggerGreeting.bind(session);
  const reading = createRealtimeReading({
    text,
    instructions: params.instructions,
    speak: triggerGreeting,
    afterPlayback: params.afterPlayback,
  });
  if (reading) {
    session.triggerGreeting = (prompt) => {
      if (prompt === params.initialGreetingInstructions) {
        reading.start();
      } else {
        reading.interrupt();
        triggerGreeting(prompt);
      }
    };
  }
  return reading;
}
