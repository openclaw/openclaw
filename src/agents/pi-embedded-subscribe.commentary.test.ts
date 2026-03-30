import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

function buildAssistantMessage(params: {
  id?: string;
  stopReason?: string;
  content: Array<Record<string, unknown>>;
}) {
  return {
    role: "assistant",
    ...(params.id ? { id: params.id } : {}),
    ...(params.stopReason ? { stopReason: params.stopReason } : {}),
    content: params.content,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("subscribeEmbeddedPiSession commentary delivery", () => {
  it("does no live commentary work when the callback is unset", async () => {
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
    });

    emit({
      type: "message_end",
      message: buildAssistantMessage({
        id: "assistant-1",
        stopReason: "toolUse",
        content: [
          {
            type: "text",
            text: "Checking the repo state now.",
            textSignature: JSON.stringify({ id: "sig-1", phase: "commentary" }),
          },
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "exec",
            args: "{}",
          },
        ],
      }),
    });

    await subscription.waitForCommentaryDelivery();

    expect(subscription.assistantOutputs).toEqual([
      {
        segmentId: "sig-1",
        text: "Checking the repo state now.",
        phase: "commentary",
      },
    ]);
    expect(subscription.deliveredCommentarySegmentIds()).toEqual([]);
    expect(subscription.getPendingCommentaryDeliveryCount()).toBe(0);
  });

  it("emits live commentary once after the segment stops being terminal", async () => {
    const onCommentaryReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onCommentaryReply,
    });

    emit({
      type: "message_start",
      message: buildAssistantMessage({
        id: "assistant-1",
        content: [],
      }),
    });
    emit({
      type: "message_update",
      message: buildAssistantMessage({
        id: "assistant-1",
        content: [
          {
            type: "text",
            text: "Step 2/3: running lint.",
            textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
          },
        ],
      }),
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Step 2/3: running lint.",
      },
    });

    await subscription.waitForCommentaryDelivery();
    expect(onCommentaryReply).not.toHaveBeenCalled();

    emit({
      type: "message_update",
      message: buildAssistantMessage({
        id: "assistant-1",
        content: [
          {
            type: "text",
            text: "Step 2/3: running lint.",
            textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
          },
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "exec",
            args: "{}",
          },
        ],
      }),
      assistantMessageEvent: {
        type: "text_delta",
        delta: "",
      },
    });

    await subscription.waitForCommentaryDelivery();
    expect(onCommentaryReply).toHaveBeenCalledTimes(1);
    expect(onCommentaryReply).toHaveBeenCalledWith(
      { text: "Step 2/3: running lint." },
      expect.objectContaining({ timeoutMs: undefined }),
    );
  });

  it("re-sends only the appended commentary suffix when a delivered segment grows", async () => {
    const onCommentaryReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onCommentaryReply,
    });

    emit({
      type: "message_update",
      message: buildAssistantMessage({
        id: "assistant-1",
        content: [
          {
            type: "text",
            text: "Step 2/3",
            textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
          },
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "exec",
            args: "{}",
          },
        ],
      }),
      assistantMessageEvent: {
        type: "text_delta",
        delta: "",
      },
    });

    await subscription.waitForCommentaryDelivery();

    emit({
      type: "message_update",
      message: buildAssistantMessage({
        id: "assistant-1",
        content: [
          {
            type: "text",
            text: "Step 2/3: running lint.",
            textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
          },
          {
            type: "toolCall",
            toolCallId: "call-2",
            toolName: "exec",
            args: "{}",
          },
        ],
      }),
      assistantMessageEvent: {
        type: "text_delta",
        delta: "",
      },
    });

    await subscription.waitForCommentaryDelivery();

    expect(onCommentaryReply).toHaveBeenCalledTimes(2);
    expect(onCommentaryReply).toHaveBeenNthCalledWith(
      1,
      { text: "Step 2/3" },
      expect.objectContaining({ timeoutMs: undefined }),
    );
    expect(onCommentaryReply).toHaveBeenNthCalledWith(
      2,
      { text: ": running lint." },
      expect.objectContaining({ timeoutMs: undefined }),
    );
    expect(subscription.deliveredCommentarySegmentIds()).toEqual(["sig-stream"]);
  });

  it("delivers undelivered commentary on message_end and preserves final outputs", async () => {
    const onCommentaryReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onCommentaryReply,
    });

    emit({
      type: "message_end",
      message: buildAssistantMessage({
        id: "assistant-1",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Checking the repo state now.",
            textSignature: JSON.stringify({ id: "sig-1", phase: "commentary" }),
          },
          {
            type: "text",
            text: " Final answer.",
            textSignature: JSON.stringify({ id: "sig-2", phase: "final_answer" }),
          },
        ],
      }),
    });

    await subscription.waitForCommentaryDelivery();

    expect(onCommentaryReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantOutputs).toEqual([
      {
        segmentId: "sig-1",
        text: "Checking the repo state now.",
        phase: "commentary",
      },
      {
        segmentId: "sig-2",
        text: "Final answer.",
        phase: "final_answer",
      },
    ]);
    expect(subscription.deliveredCommentarySegmentIds()).toEqual(["sig-1"]);
  });

  it("merges repeated text blocks that share the same signature id", async () => {
    const onCommentaryReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onCommentaryReply,
    });

    emit({
      type: "message_end",
      message: buildAssistantMessage({
        id: "assistant-1",
        stopReason: "toolUse",
        content: [
          {
            type: "text",
            text: "Checking ",
            textSignature: JSON.stringify({ id: "sig-merge", phase: "commentary" }),
          },
          {
            type: "text",
            text: "the repo state now.",
            textSignature: JSON.stringify({ id: "sig-merge", phase: "commentary" }),
          },
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "exec",
            args: "{}",
          },
        ],
      }),
    });

    await subscription.waitForCommentaryDelivery();

    expect(onCommentaryReply).toHaveBeenCalledTimes(1);
    expect(onCommentaryReply).toHaveBeenCalledWith(
      { text: "Checking the repo state now." },
      expect.objectContaining({ timeoutMs: undefined }),
    );
    expect(subscription.assistantOutputs).toEqual([
      {
        segmentId: "sig-merge",
        text: "Checking the repo state now.",
        phase: "commentary",
      },
    ]);
  });

  it("keeps repeated identical unsigned commentary distinct across assistant turns", async () => {
    const onCommentaryReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onCommentaryReply,
    });

    const firstMessage = buildAssistantMessage({
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "Still working...",
          phase: "commentary",
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
      ],
    });
    const secondMessage = buildAssistantMessage({
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "Still working...",
          phase: "commentary",
        },
        {
          type: "toolCall",
          toolCallId: "call-2",
          toolName: "exec",
          args: "{}",
        },
      ],
    });

    emit({ type: "message_start", message: firstMessage });
    emit({ type: "message_end", message: firstMessage });
    emit({ type: "message_start", message: secondMessage });
    emit({ type: "message_end", message: secondMessage });

    await subscription.waitForCommentaryDelivery();

    expect(subscription.assistantOutputs).toHaveLength(2);
    expect(subscription.assistantOutputs[0]?.text).toBe("Still working...");
    expect(subscription.assistantOutputs[1]?.text).toBe("Still working...");
    expect(subscription.assistantOutputs[0]?.segmentId).not.toBe(
      subscription.assistantOutputs[1]?.segmentId,
    );
    expect(onCommentaryReply).toHaveBeenCalledTimes(2);
  });

  it("keeps unsigned fallback ids stable across late updates after message_end", async () => {
    const onCommentaryReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onCommentaryReply,
    });

    const assistantMessage = buildAssistantMessage({
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "Still working...",
          phase: "commentary",
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
      ],
    });

    emit({ type: "message_start", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });
    emit({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "text_delta",
        delta: "",
      },
    });

    await subscription.waitForCommentaryDelivery();

    expect(onCommentaryReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantOutputs).toEqual([
      {
        segmentId: "assistant:stream-0:segment:0",
        text: "Still working...",
        phase: "commentary",
      },
    ]);
    expect(subscription.deliveredCommentarySegmentIds()).toEqual(["assistant:stream-0:segment:0"]);
  });

  it("waits for commentary queued after the wait has already started", async () => {
    const firstDelivery = createDeferred<void>();
    const secondDelivery = createDeferred<void>();
    const onCommentaryReply = vi
      .fn()
      .mockImplementationOnce(() => firstDelivery.promise)
      .mockImplementationOnce(() => secondDelivery.promise);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onCommentaryReply,
    });

    const firstMessage = buildAssistantMessage({
      id: "assistant-1",
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "First step.",
          textSignature: JSON.stringify({ id: "sig-1", phase: "commentary" }),
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
      ],
    });
    const secondMessage = buildAssistantMessage({
      id: "assistant-2",
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "Second step.",
          textSignature: JSON.stringify({ id: "sig-2", phase: "commentary" }),
        },
        {
          type: "toolCall",
          toolCallId: "call-2",
          toolName: "exec",
          args: "{}",
        },
      ],
    });

    emit({ type: "message_start", message: firstMessage });
    emit({ type: "message_end", message: firstMessage });

    let waitResolved = false;
    const waitPromise = subscription.waitForCommentaryDelivery().then(() => {
      waitResolved = true;
    });

    emit({ type: "message_start", message: secondMessage });
    emit({ type: "message_end", message: secondMessage });

    firstDelivery.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(waitResolved).toBe(false);

    secondDelivery.resolve();
    await waitPromise;

    expect(onCommentaryReply).toHaveBeenCalledTimes(2);
    expect(subscription.deliveredCommentarySegmentIds()).toEqual(["sig-1", "sig-2"]);
  });

  it("aborts stale commentary work on compaction retry and keeps delivered ids for replay suppression", async () => {
    const firstDelivery = createDeferred<void>();
    const onCommentaryReply = vi
      .fn()
      .mockImplementationOnce((_payload, context?: { abortSignal?: AbortSignal }) => {
        context?.abortSignal?.addEventListener(
          "abort",
          () => {
            firstDelivery.reject(context.abortSignal?.reason ?? new Error("aborted"));
          },
          { once: true },
        );
        return firstDelivery.promise;
      })
      .mockResolvedValueOnce(undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onCommentaryReply,
    });

    emit({
      type: "message_update",
      message: buildAssistantMessage({
        id: "assistant-1",
        content: [
          {
            type: "text",
            text: "Step 2/3: running lint.",
            textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
          },
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "exec",
            args: "{}",
          },
        ],
      }),
      assistantMessageEvent: {
        type: "text_delta",
        delta: "",
      },
    });

    await Promise.resolve();
    emit({ type: "auto_compaction_end", willRetry: true });
    emit({
      type: "message_update",
      message: buildAssistantMessage({
        id: "assistant-1",
        content: [
          {
            type: "text",
            text: "Step 2/3: running lint.",
            textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
          },
          {
            type: "toolCall",
            toolCallId: "call-2",
            toolName: "exec",
            args: "{}",
          },
        ],
      }),
      assistantMessageEvent: {
        type: "text_delta",
        delta: "",
      },
    });

    await subscription.waitForCommentaryDelivery();

    expect(onCommentaryReply).toHaveBeenCalledTimes(2);
    expect(subscription.deliveredCommentarySegmentIds()).toEqual(["sig-stream"]);
  });
});
