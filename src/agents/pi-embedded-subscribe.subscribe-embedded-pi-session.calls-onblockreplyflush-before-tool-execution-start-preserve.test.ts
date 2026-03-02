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
  it("flushes buffered block chunks before tool execution", () => {
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

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });
});
