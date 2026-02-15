import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession - split thinking tags", () => {
  it("buffers partial <think> tags across chunks", () => {
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
      runId: "run-split",
      onBlockReply,
      blockReplyBreak: "message_end",
      reasoningMode: "off",
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // Chunk 1: Text + partial open tag
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Start <think",
      },
    });

    // Chunk 2: Rest of open tag with attribute + content
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: ' id="trace-123">Hidden thinking',
      },
    });

    // Chunk 3: Close tag + final text
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "</think> End",
      },
    });

    handler?.({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: 'Start <think id="trace-123">Hidden thinking</think> End' },
        ],
      },
    });

    // Collect all emitted text
    const emittedTexts = onBlockReply.mock.calls.map((c) => c[0].text).join("");

    // With current implementation (stateless), "Start <think" is emitted in chunk 1,
    // and " id=...>Hidden..." is emitted in chunk 2.
    // So full text will be "Start <think id=...>Hidden...</think> End" (FAIL)

    // We want "Start End" (PASS)
    expect(emittedTexts).not.toContain("Hidden thinking");
    expect(emittedTexts.replace(/\s+/g, " ").trim()).toBe("Start End");
  });
});
