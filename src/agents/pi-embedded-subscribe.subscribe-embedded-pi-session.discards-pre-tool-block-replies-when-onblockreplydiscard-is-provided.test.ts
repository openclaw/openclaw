import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession", () => {
  it("flushes pre-tool block replies when text already passed through text_end", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();
    const onBlockReplyDiscard = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-flush-after-text-end",
      onBlockReply,
      onBlockReplyFlush,
      onBlockReplyDiscard,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 500, maxChars: 1000 },
    });

    handler?.({
      type: "message_start",
      message: { role: "assistant" },
    });

    // Simulate acknowledgment text
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Let me check your calendar.",
      },
    });

    // text_end drains the chunker into the pipeline
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "Let me check your calendar.",
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // Tool execution starts — chunker is empty, text already in pipeline.
    // Should flush (preserve ack text), not discard.
    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-flush-1",
      args: { command: "icalbuddy eventsToday" },
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(onBlockReplyDiscard).not.toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("discards pre-tool block replies when text is still in chunker buffer", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();
    const onBlockReplyDiscard = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-discard-mid-stream",
      onBlockReply,
      onBlockReplyFlush,
      onBlockReplyDiscard,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 500, maxChars: 1000 },
    });

    handler?.({
      type: "message_start",
      message: { role: "assistant" },
    });

    // Simulate hedging text — no text_end, still in chunker buffer
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "I don't have access to your calendar.",
      },
    });

    // Tool starts before text_end — text is mid-stream hedging.
    // Should discard.
    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-discard-1",
      args: { command: "icalbuddy eventsToday" },
    });

    expect(onBlockReplyDiscard).toHaveBeenCalledTimes(1);
    expect(onBlockReplyFlush).not.toHaveBeenCalled();
    // onBlockReply was never called (text stayed in chunker, never drained)
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("falls back to flush when onBlockReplyDiscard is not provided", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-fallback-flush",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    handler?.({
      type: "message_start",
      message: { role: "assistant" },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Some text before tool.",
      },
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-fallback-1",
      args: { command: "ls" },
    });

    // Without onBlockReplyDiscard, should fall back to flush
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });
});
