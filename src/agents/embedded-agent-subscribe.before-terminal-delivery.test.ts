// Before-terminal-delivery tests cover the async gate that can suppress or
// release deferred assistant events and block replies at run completion.
import { describe, expect, it, vi } from "vitest";
import {
  emitAssistantTextDeltaAndEnd,
  createSubscribedSessionHarness,
  emitMessageStartAndEndForAssistantText,
} from "./embedded-agent-subscribe.e2e-harness.js";

function hasAssistantEvent(calls: Array<unknown[]>): boolean {
  // The gate buffers channel partial replies; gateway SSE events stream immediately.
  // nothing leaks before the terminal decision resolves.
  return calls.some((call) => {
    const event = call[0] as { stream?: string } | undefined;
    return event?.stream === "assistant";
  });
}

function hasLifecycleEndEvent(calls: Array<unknown[]>): boolean {
  return calls.some((call) => {
    const event = call[0] as { stream?: string; data?: { phase?: string } } | undefined;
    return event?.stream === "lifecycle" && event.data?.phase === "end";
  });
}

describe("subscribeEmbeddedAgentSession before terminal delivery", () => {
  it("suppresses deferred block replies when the terminal gate requests a revision", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => ({
      suppressTerminalDelivery: true,
    }));
    const { emit } = createSubscribedSessionHarness({
      runId: "run-before-terminal-revise",
      onBlockReply,
      onAgentEvent,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "First answer.",
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    // Gateway SSE events stream immediately even when a before_agent_finalize
    // hook is registered; only partial replies and block replies are deferred.
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(true);

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "First answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBeforeTerminalDelivery).toHaveBeenCalledTimes(1));
    expect(onBeforeTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        hasAssistantVisibleText: true,
        isError: false,
        incompleteTerminalAssistant: false,
        willRetry: false,
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
    // Gateway assistant events were already emitted during generation;
    // suppressTerminalDelivery clears deferred buffers but cannot retract
    // already-streamed SSE.
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(true);
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(false);
  });

  it("waits for async terminal gate decisions before draining", async () => {
    // waitForPendingEvents must include the gate promise or callers can observe
    // a drained subscription before terminal delivery has been decided.
    const onBlockReply = vi.fn();
    let resolveGate: ((value: { suppressTerminalDelivery: true }) => void) | undefined;
    const onBeforeTerminalDelivery = vi.fn(
      () =>
        new Promise<{ suppressTerminalDelivery: true }>((resolve) => {
          resolveGate = resolve;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-wait",
      onBlockReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Slow revise answer.",
    });
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Slow revise answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBeforeTerminalDelivery).toHaveBeenCalledTimes(1));
    let drained = false;
    const waitPromise = subscription.waitForPendingEvents().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveGate?.({ suppressTerminalDelivery: true });
    await waitPromise;
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("defers channel partial replies but streams gateway SSE until the terminal gate continues", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-assistant-stream",
      onAgentEvent,
      onPartialReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitAssistantTextDeltaAndEnd({
      emit,
      text: "Visible stream.",
    });
    // Gateway SSE events stream immediately during generation; only channel
    // partial replies are deferred until the terminal gate resolves.
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(true);
    expect(onPartialReply).not.toHaveBeenCalled();

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Visible stream." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(true);
    expect(onPartialReply).toHaveBeenCalled();
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(true);
  });

  it("does not send final-only assistant events through partial replies", async () => {
    const onPartialReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-final-only",
      onPartialReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Final only.",
    });
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Final only." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("finalizes normally when the terminal gate rejects", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => {
      throw new Error("hook failed");
    });
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-reject",
      onBlockReply,
      onAgentEvent,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Fallback answer.",
    });
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Fallback answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Fallback answer." }),
    );
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(true);
  });

  it("flushes deferred block replies when the terminal gate continues", async () => {
    const onBlockReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => undefined);
    const { emit } = createSubscribedSessionHarness({
      runId: "run-before-terminal-continue",
      onBlockReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Accepted answer.",
    });
    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Accepted answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledTimes(1));
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Accepted answer." }),
    );
  });

  it("emits a replace signal when the terminal gate suppresses delivery for revision", async () => {
    // suppressTerminalDelivery must directly emit a replace event (not via
    // subscription state) because production revision creates a new
    // subscription with fresh state for the second attempt.
    const onAgentEvent = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => ({
      suppressTerminalDelivery: true,
    }));
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-replace",
      onAgentEvent,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    // First attempt: text streams immediately.
    emitAssistantTextDeltaAndEnd({
      emit,
      text: "First try.",
    });
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(true);

    // Hook suppresses terminal delivery. The lifecycle handler must emit
    // a replace event so the gateway projector clears the stale buffer
    // from the first attempt before the second attempt starts.
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "First try." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });
    await vi.waitFor(() => expect(onBeforeTerminalDelivery).toHaveBeenCalledTimes(1));
    await subscription.waitForPendingEvents();

    // The suppressTerminalDelivery path must emit a replace-only event
    // (no text) so the gateway clears rawBuffers for this runId.
    const replaceEvent = onAgentEvent.mock.calls
      .map((call) => call[0])
      .find(
        (e) =>
          e?.stream === "assistant" &&
          (e as { data?: { replace?: boolean } }).data?.replace === true,
      );
    expect(replaceEvent).toBeDefined();
    // No lifecycle end because the run continues with a revision attempt.
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(false);
  });
});
