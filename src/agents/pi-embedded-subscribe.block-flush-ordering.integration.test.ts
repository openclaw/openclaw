/**
 * Integration test for issue #15968: block reply flush not awaited before tool execution.
 *
 * Verifies that when `onBlockReplyFlush` is async (simulating real HTTP I/O),
 * the flush completes BEFORE subsequent events are processed. The fix serializes
 * events through a promise chain when a flush callback is present, so the
 * tool_execution_start handler awaits the flush before the chain moves on.
 */
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

/** Flush pending microtasks so the async event handler chain settles. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe("block flush ordering (integration) — issue #15968", () => {
  it("awaits async flush before processing subsequent events", async () => {
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

    const onBlockReplyFlush = vi.fn(() =>
      flushPromise.then(() => {
        callOrder.push("flush_resolved");
      }),
    );

    const onBlockReply = vi.fn(() => {
      callOrder.push("block_reply");
    });

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-async-flush",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "On it.",
      },
    });

    // tool_execution_start triggers flush via the promise chain
    handler?.({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-async-1",
      args: { command: "echo hello" },
    });

    // Post-tool text arrives while flush is still pending — should be queued
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Done.",
      },
    });

    await flushMicrotasks();

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    // Flush was called but hasn't resolved yet
    expect(callOrder).not.toContain("flush_resolved");

    // Resolve the flush
    resolveFlush();
    await flushMicrotasks();

    expect(callOrder).toContain("flush_resolved");
  });

  it("flush completes before tool message overtakes narration (HTTP race)", async () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const deliveryOrder: string[] = [];

    const onBlockReply = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      deliveryOrder.push("narration_delivered");
    });

    const onBlockReplyFlush = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      deliveryOrder.push("flush_done");
    });

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-http-race",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Let me send you a message now.",
      },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        text: "Let me send you a message now.",
      },
    });

    // tool_execution_start — flush is awaited on the chain before this completes
    handler?.({
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-msg-race",
      args: { action: "sendMessage", content: "The actual message" },
    });

    // Wait for everything to settle
    await new Promise((resolve) => setTimeout(resolve, 150));

    // flush_done must appear — the flush was awaited, not fire-and-forget
    expect(deliveryOrder).toContain("flush_done");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });

  it("rejected flush does not break the event handler chain", async () => {
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

    handler?.({ type: "message_start", message: { role: "assistant" } });

    // tool_execution_start — flush will reject
    handler?.({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-reject-1",
      args: { command: "echo hello" },
    });

    // Post-tool text — should still be processed after the rejected flush
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "After rejected flush.",
      },
    });

    await flushMicrotasks();

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    // Chain continued despite rejection — no unhandled promise rejection
  });
});
