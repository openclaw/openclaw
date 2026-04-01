import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("calls onBlockReplyFlush before tool_execution_start to preserve message boundaries", () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReplyFlush = vi.fn();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-flush-test",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    // Simulate text arriving before tool
    emit({
      type: "message_start",
      message: { role: "assistant" },
    });

    emitAssistantTextDelta({ emit, delta: "First message before tool." });

    expect(onBlockReplyFlush).not.toHaveBeenCalled();

    // Tool execution starts - should trigger flush
    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-flush-1",
      args: { command: "echo hello" },
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);

    // Another tool - should flush again
    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-flush-2",
      args: { path: "/tmp/test.txt" },
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(2);
  });
  it("flushes buffered block chunks before tool execution", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-flush-buffer",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 50, maxChars: 200 },
    });

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });

    emitAssistantTextDelta({ emit, delta: "Short chunk." });

    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-flush-buffer-1",
      args: { command: "echo flush" },
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Short chunk.");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });

  it("calls onBlockReplyFlush at message_end for message-boundary turns", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-message-end-flush",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "message_end",
    });

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });
    emitAssistantTextDelta({ emit, delta: "Final reply before lifecycle end." });
    expect(onBlockReplyFlush).not.toHaveBeenCalled();

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final reply before lifecycle end." }],
      },
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Final reply before lifecycle end.");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });
});
