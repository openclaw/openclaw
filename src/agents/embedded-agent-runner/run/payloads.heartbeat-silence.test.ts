// Heartbeat turns that captured no assistant output of their own must be a true
// no-op: no reply payload may be built from an older assistant message, which
// would re-commit and re-deliver the previous final reply (#143787).
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildPayloads } from "./payloads.test-helpers.js";

const previousFinalReply = {
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text: "Ship it: the release notes are ready." }],
} as unknown as AssistantMessage;

describe("buildEmbeddedRunPayloads heartbeat silence", () => {
  it("does not resurrect the previous final reply for a yielded heartbeat attempt", () => {
    const payloads = buildPayloads({
      isHeartbeatTrigger: true,
      // A yielded attempt ends before message_end: no assistant message of its
      // own was captured for this turn.
      currentAssistant: null,
      // The session snapshot's newest assistant is the previous turn's final.
      lastAssistant: previousFinalReply,
    });

    expect(payloads).toEqual([]);
  });

  it("keeps a captured heartbeat reply deliverable", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Build needs credentials."],
      isHeartbeatTrigger: true,
      currentAssistant: null,
      lastAssistant: previousFinalReply,
    });

    expect(payloads.map((payload) => payload.text)).toEqual(["Build needs credentials."]);
  });
});
