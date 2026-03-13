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

describe("subscribeEmbeddedPiSession commentary delivery", () => {
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
    expect(onCommentaryReply).toHaveBeenCalledWith({
      text: "Step 2/3: running lint.",
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

    await subscription.waitForCommentaryDelivery();
    expect(onCommentaryReply).toHaveBeenCalledTimes(1);
  });

  it("adds finalized outputs in order and delivers undelivered commentary on message_end", async () => {
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

  it("does not mark commentary as delivered when the callback fails", async () => {
    const onCommentaryReply = vi.fn(async () => {
      throw new Error("send failed");
    });
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
    ]);
    expect(subscription.deliveredCommentarySegmentIds()).toEqual([]);
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
});
