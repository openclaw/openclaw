import {
  createTalkSessionController,
  type TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it } from "vitest";
import { summarizeRecentTalkEvents } from "../src/talk-events-summary.js";

describe("talk event summaries", () => {
  it("returns compact status-safe summaries for recent talk events", () => {
    const talk = createTalkSessionController({
      sessionId: "facetime:call-1",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "test",
    });
    const inputs = [
      ...Array.from({ length: 9 }, () => ({
        type: "session.started" as const,
        payload: { callUUID: "call-1" },
      })),
      { type: "input.audio.delta", turnId: "turn-1", payload: { byteLength: 2400 } },
      { type: "transcript.done", turnId: "turn-1", payload: { role: "user", text: "hello" } },
      { type: "tool.call", turnId: "turn-1", callId: "tool-1", payload: { name: "lookup" } },
      {
        type: "session.error",
        final: true,
        payload: { message: "provider failed", detail: "not included" },
      },
    ] satisfies TalkEventInput[];
    const events = inputs.map((event) => talk.emit<typeof event.payload>(event));

    expect(summarizeRecentTalkEvents(events)).toEqual([
      ...Array.from({ length: 8 }, () => ({ type: "session.started" })),
      { type: "input.audio.delta", turnId: "turn-1", byteLength: 2400 },
      { type: "transcript.done", turnId: "turn-1", text: "hello" },
      { type: "tool.call", turnId: "turn-1", callId: "tool-1", name: "lookup" },
      { type: "session.error", final: true, message: "provider failed" },
    ]);
  });
});
