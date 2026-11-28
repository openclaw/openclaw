import { randomUUID } from "node:crypto";
import {
  buildRealtimeVoiceSpeakExactMessage,
  type RealtimeVoiceResponseOutcome,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";

const PASSAGE_CHARACTERS = 480;
export const READING_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: "openclaw_statement",
  description:
    "Control an interrupted host-prepared statement, only in response to the caller. The host starts statements and supplies passages: read only the quoted Answer text aloud, without its label, the playback directions, or a tool call. The host retains the full unfinished statement; never ask the caller to supply it again. After an interruption, answer the caller first; resume only when appropriate, and stop only if the caller explicitly asks to abandon the statement. Never recite the remainder yourself. Resume repeats the last unacknowledged short passage, so no unheard words are skipped. Speak any answer before calling resume; the host handles the reading after this tool returns.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["resume", "stop"] },
    },
    required: ["action"],
  },
};

function splitPassages(text: string): string[] {
  const passages: string[] = [];
  let remaining = text;
  while (remaining.length > PASSAGE_CHARACTERS) {
    const sentence = [
      ...remaining.slice(0, PASSAGE_CHARACTERS + 1).matchAll(/[.!?]["'”’]?\s+/gu),
    ].at(-1);
    let end = sentence
      ? sentence.index + sentence[0].length
      : remaining.lastIndexOf(" ", PASSAGE_CHARACTERS);
    if (end <= 0) {
      end = PASSAGE_CHARACTERS;
      if (/^[\uDC00-\uDFFF]$/u.test(remaining[end] ?? "")) {
        end -= 1;
      }
    } else if (!sentence) {
      end += 1;
    }
    passages.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  passages.push(remaining);
  return passages;
}

export function attachRealtimeReading(params: {
  session: RealtimeVoiceBridgeSession;
  text: string | undefined;
  initialGreetingInstructions: string | undefined;
  handlesAgentConsult: boolean;
  afterPlayback: (mark: string, acknowledge: () => void) => void;
}) {
  const { session, text } = params;
  if (params.handlesAgentConsult || session.bridge.outputAudioMode === "continuous") {
    return undefined;
  }
  const triggerGreeting = session.triggerGreeting.bind(session);
  let passages = text && text.length > PASSAGE_CHARACTERS ? splitPassages(text) : [];
  let managed = passages.length > 0;
  let index = 0;
  let phase: "ready" | "requested" | "generating" | "playing" | "paused" | "stopped" =
    passages.length ? "ready" : "stopped";
  let responseId: string | undefined;
  let playbackMark: string | undefined;
  const cancel = () => {
    phase = "stopped";
    passages = [];
    playbackMark = undefined;
  };
  const interrupt = () => {
    if (phase !== "stopped") {
      phase = "paused";
      playbackMark = undefined;
    }
  };
  const speak = () => {
    phase = "requested";
    responseId = undefined;
    triggerGreeting(
      [
        "This is a host playback request. Speak only the quoted text in the Answer field below, not the field label or these directions. Do not add a greeting, summary, or closing. Stop after this passage; the host supplies the next after playback. If interrupted, listen and answer normally; use openclaw_statement to resume or stop the retained statement, never improvise its remainder.",
        buildRealtimeVoiceSpeakExactMessage({
          text: passages[index] ?? "",
          surfaceLabel: "the callee",
        }),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  };
  const afterPlayback = (advance: () => void) => {
    const mark = `openclaw-reading-${randomUUID()}`;
    playbackMark = mark;
    phase = "playing";
    params.afterPlayback(mark, () => {
      // Cleared carrier marks can arrive after interruption or a later resume.
      if (phase !== "playing" || playbackMark !== mark) {
        return;
      }
      playbackMark = undefined;
      advance();
    });
  };
  session.triggerGreeting = (prompt) => {
    if (prompt === params.initialGreetingInstructions && managed) {
      if (phase === "ready") {
        speak();
      } else if (phase === "paused") {
        triggerGreeting(
          "The caller interrupted before the prepared statement began. The host retains the complete statement. Respond to the caller naturally; when they are ready, use openclaw_statement with action resume. Do not ask them to supply the text again.",
        );
      }
    } else {
      interrupt();
      triggerGreeting(prompt);
    }
  };
  return {
    cancel,
    interrupt,
    // Override opening suppression only for a managed statement; ordinary short greetings retain it.
    isInterruptible: () => managed,
    startText(value: string) {
      if (value.length <= PASSAGE_CHARACTERS) {
        return false;
      }
      managed = true;
      passages = splitPassages(value);
      index = 0;
      speak();
      return true;
    },
    responseStarted(id?: string) {
      if (phase === "requested") {
        responseId = id;
        phase = "generating";
      }
    },
    responseDone(outcome: RealtimeVoiceResponseOutcome) {
      if (phase !== "generating" || (responseId && responseId !== outcome.responseId)) {
        return;
      }
      if (outcome.status !== "completed") {
        interrupt();
        return;
      }
      afterPlayback(() => {
        index += 1;
        if (index === passages.length) {
          cancel();
        } else {
          speak();
        }
      });
    },
    async control(args: unknown, invocationId: string) {
      if (!args || typeof args !== "object" || !("action" in args)) {
        await session.submitToolResult(invocationId, { error: "Expected resume or stop." });
        return;
      }
      if (args.action === "stop") {
        cancel();
        await session.submitToolResult(invocationId, { stopped: true });
        return;
      }
      if (args.action !== "resume" || phase !== "paused" || !passages.length) {
        await session.submitToolResult(invocationId, {
          error:
            "Only resume a paused host statement. The host supplies passages to read directly; this tool cannot start or replace them.",
        });
        return;
      }
      // Finish any answer already spoken by the model before restarting a passage.
      // Suppression prevents an automatic extra response racing the host's reading.
      phase = "ready";
      await session.submitToolResult(
        invocationId,
        { reading: "queued" },
        { suppressResponse: true },
      );
      if (phase === "ready") {
        afterPlayback(speak);
      }
    },
  };
}
