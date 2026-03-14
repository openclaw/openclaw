import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

/**
 * Regression tests for #46002 — blockStreamingBreak:"text_end" must deliver
 * intermediate text before tool calls, not after all tool calls complete.
 *
 * Root cause: emitBlockReplySafely used `void Promise.resolve().then(onBlockReply)`
 * which deferred the pipeline enqueue to a microtask. When handleToolExecutionStart
 * called onBlockReplyFlush(), the pipeline was still empty — text arrived only after
 * the flush completed, leaving it stuck until the idle-timeout fired.
 *
 * Fix: call params.onBlockReply synchronously in emitBlockReplySafely so text is
 * enqueued to the pipeline before onBlockReplyFlush() drains it.
 */
describe("subscribeEmbeddedPiSession — pre-tool text flush (blockStreamingBreak: text_end)", () => {
  it("delivers pre-tool text via onBlockReply before onBlockReplyFlush when text_end fires before tool start", () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-46002-text-end",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    emit({ type: "message_start", message: { role: "assistant" } });

    // Simulate text streaming in before the tool call
    emitAssistantTextDelta({ emit, delta: "Thinking out loud before using a tool." });

    // text_end fires — with blockStreamingBreak:"text_end", this should immediately
    // enqueue the text via onBlockReply so the pipeline has it before the tool flushes
    emitAssistantTextEnd({ emit });

    // At this point, onBlockReply must have been called synchronously (not deferred)
    // so the pipeline already holds the pre-tool text.
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Thinking out loud before using a tool.");

    // Now a tool starts — this triggers onBlockReplyFlush to drain the pipeline
    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-46002-1",
      args: { command: "echo hello" },
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);

    // Critical: onBlockReply (text enqueue) MUST precede onBlockReplyFlush (pipeline drain).
    // If onBlockReply was deferred (old bug), it would be called AFTER onBlockReplyFlush,
    // meaning the flush saw an empty pipeline and the text was never delivered before the tool.
    expect(onBlockReply.mock.invocationCallOrder[0]).toBeLessThan(
      onBlockReplyFlush.mock.invocationCallOrder[0],
    );
  });

  it("delivers pre-tool text via onBlockReply before onBlockReplyFlush across multiple tool calls", () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-46002-multi-tool",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Pre-tool message." });
    emitAssistantTextEnd({ emit });

    // Text must be enqueued before first tool flush
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-46002-a",
      args: { command: "ls" },
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.invocationCallOrder[0]).toBeLessThan(
      onBlockReplyFlush.mock.invocationCallOrder[0],
    );
  });
});
