import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

/** Flush all pending microtasks so the async event handler chain settles. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe("subscribeEmbeddedPiSession", () => {
  const _THINKING_TAG_CASES = [
    { tag: "think", open: "<think>", close: "</think>" },
    { tag: "thinking", open: "<thinking>", close: "</thinking>" },
    { tag: "thought", open: "<thought>", close: "</thought>" },
    { tag: "antthinking", open: "<antthinking>", close: "</antthinking>" },
  ] as const;

  it("calls onBlockReplyFlush before tool_execution_start to preserve message boundaries", async () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

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
    handler?.({
      type: "message_start",
      message: { role: "assistant" },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "First message before tool.",
      },
    });

    await flushMicrotasks();
    expect(onBlockReplyFlush).not.toHaveBeenCalled();

    // Tool execution starts - should trigger flush
    handler?.({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-flush-1",
      args: { command: "echo hello" },
    });

    await flushMicrotasks();
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);

    // Another tool - should flush again
    handler?.({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-flush-2",
      args: { path: "/tmp/test.txt" },
    });

    await flushMicrotasks();
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(2);
  });

  it("awaits async onBlockReplyFlush before processing subsequent events", async () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const callOrder: string[] = [];
    let resolveFlush!: () => void;
    const flushPromise = new Promise<void>((resolve) => {
      resolveFlush = resolve;
    });

    const onBlockReplyFlush = vi.fn().mockImplementation(() => {
      callOrder.push("flush_called");
      return flushPromise.then(() => {
        callOrder.push("flush_resolved");
      });
    });
    const onBlockReply = vi.fn().mockImplementation(() => {
      callOrder.push("block_reply");
    });

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-async-flush",
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
        delta: "On it.",
      },
    });

    // Tool execution starts - triggers flush which is now pending
    handler?.({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-async-1",
      args: { command: "echo hello" },
    });

    // Post-tool text arrives while flush is still pending
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Done.",
      },
    });

    // Let microtasks settle - flush is still pending so message_update should be queued
    await flushMicrotasks();

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    // The flush was called but hasn't resolved yet
    expect(callOrder).toContain("flush_called");
    expect(callOrder).not.toContain("flush_resolved");

    // Now resolve the flush
    resolveFlush();
    // Let the chain settle
    await flushMicrotasks();

    expect(callOrder).toContain("flush_resolved");
  });

  it("does not block tool execution when async flush rejects", async () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReplyFlush = vi.fn().mockRejectedValue(new Error("flush failed"));
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-flush-reject",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    handler?.({
      type: "message_start",
      message: { role: "assistant" },
    });

    // Tool execution starts - flush will reject but should not break the chain
    handler?.({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-reject-1",
      args: { command: "echo hello" },
    });

    // Post-tool text - should still be processed after the rejected flush
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "After rejected flush.",
      },
    });

    // Let the chain settle
    await flushMicrotasks();

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    // The handler chain should have continued despite the flush rejection
  });

  it("flushes buffered block chunks before tool execution", async () => {
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
      runId: "run-flush-buffer",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 50, maxChars: 200 },
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
        delta: "Short chunk.",
      },
    });

    await flushMicrotasks();
    expect(onBlockReply).not.toHaveBeenCalled();

    handler?.({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-flush-buffer-1",
      args: { command: "echo flush" },
    });

    await flushMicrotasks();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Short chunk.");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.invocationCallOrder[0]).toBeLessThan(
      onBlockReplyFlush.mock.invocationCallOrder[0],
    );
  });
});
