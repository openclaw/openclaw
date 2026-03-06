import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("calls onBlockReplyHold (not onBlockReplyFlush) before tool_execution_start when available", () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReplyHold = vi.fn();
    const onBlockReplyFlush = vi.fn();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-hold-test",
      onBlockReply,
      onBlockReplyFlush,
      onBlockReplyHold,
      blockReplyBreak: "text_end",
    });

    // Simulate text arriving before tool
    emit({
      type: "message_start",
      message: { role: "assistant" },
    });

    emitAssistantTextDelta({ emit, delta: "First message before tool." });

    expect(onBlockReplyHold).not.toHaveBeenCalled();
    expect(onBlockReplyFlush).not.toHaveBeenCalled();

    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-hold-1",
      args: { command: "echo hello" },
    });

    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-hold-2",
      args: { path: "/tmp/test.txt" },
    });

    expect(onBlockReplyHold).toHaveBeenCalledTimes(2);
    expect(onBlockReplyFlush).not.toHaveBeenCalled();
  });

  it("falls back to onBlockReplyFlush before tool_execution_start when hold callback is unavailable", () => {
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

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });

    emitAssistantTextDelta({ emit, delta: "First message before tool." });

    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-flush-1",
      args: { command: "echo hello" },
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });

  it("drains buffered block chunks before invoking onBlockReplyFlush fallback", () => {
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

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Short chunk.");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.invocationCallOrder[0]).toBeLessThan(
      onBlockReplyFlush.mock.invocationCallOrder[0],
    );
  });
});
