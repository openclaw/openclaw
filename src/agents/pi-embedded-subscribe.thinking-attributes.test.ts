import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession - thinking with attributes", () => {
  it("streams <think> tags with attributes without leaking into final text", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      reasoningMode: "off", // Important: we want to strip reasoning
    });

    // Simulate a stream where thinking tags have attributes (e.g. Gemini trace)
    handler?.({ type: "message_start", message: { role: "assistant" } });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        // This tag has an attribute, which the current regex fails to match
        delta: `<think id="trace-123">\nInternal reasoning\n</think>\nFinal answer`,
      },
    });

    handler?.({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `<think id="trace-123">\nInternal reasoning\n</think>\nFinal answer`,
          },
        ],
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const replyText = onBlockReply.mock.calls[0][0].text;

    // IF the regex is weak, it won't stripped, so we expect "Internal reasoning" to be present (FAIL)
    // IF the regex is strong, it will be stripped, so we expect only "Final answer" (PASS)

    // We assert what we WANT (that it IS stripped).
    // So this test SHOULD FAIL with current code.
    expect(replyText).not.toContain("Internal reasoning");
    expect(replyText).not.toContain("<think");
    expect(replyText.trim()).toBe("Final answer");
  });
});
