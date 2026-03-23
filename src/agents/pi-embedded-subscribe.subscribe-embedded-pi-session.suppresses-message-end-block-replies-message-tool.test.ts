import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

function createBlockReplyHarness(blockReplyBreak: "message_end" | "text_end") {
  const { session, emit } = createStubSessionHarness();
  const onBlockReply = vi.fn();
  subscribeEmbeddedPiSession({
    session,
    runId: "run",
    onBlockReply,
    blockReplyBreak,
  });
  return { emit, onBlockReply };
}

async function emitMessageToolLifecycle(params: {
  emit: (evt: unknown) => void;
  toolCallId: string;
  message: string;
  result: unknown;
}) {
  params.emit({
    type: "tool_execution_start",
    toolName: "message",
    toolCallId: params.toolCallId,
    args: { action: "send", to: "+1555", message: params.message },
  });
  // Wait for async handler to complete.
  await Promise.resolve();
  params.emit({
    type: "tool_execution_end",
    toolName: "message",
    toolCallId: params.toolCallId,
    isError: false,
    result: params.result,
  });
}

function emitAssistantMessageEnd(emit: (evt: unknown) => void, text: string) {
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
  } as AssistantMessage;
  emit({ type: "message_end", message: assistantMessage });
}

function emitAssistantTextEndBlock(emit: (evt: unknown) => void, text: string) {
  emit({ type: "message_start", message: { role: "assistant" } });
  emitAssistantTextDelta({ emit, delta: text });
  emitAssistantTextEnd({ emit });
}

async function flushAsyncCallbacks() {
  await Promise.resolve();
}

describe("subscribeEmbeddedPiSession", () => {
  it("suppresses message_end block replies for intermediate toolUse turns with tool-call blocks", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "让我检查状态：" },
          { type: "toolCall", id: "call_1", name: "process", arguments: { action: "poll" } },
        ],
      } as AssistantMessage,
    });

    await flushAsyncCallbacks();
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("keeps message_end block replies for normal stop turns", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "最终结论：ORDER_TEST_DONE，退出码0。" }],
      } as AssistantMessage,
    });

    await flushAsyncCallbacks();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "最终结论：ORDER_TEST_DONE，退出码0。" }),
    );
  });

  it("does not suppress toolUse turns that do not include tool-call blocks", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "text", text: "这是普通文本，不包含工具调用块。" }],
      } as AssistantMessage,
    });

    await flushAsyncCallbacks();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "这是普通文本，不包含工具调用块。" }),
    );
  });

  it("suppresses message_end block replies when the message tool already sent", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "This is the answer.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-1",
      message: messageText,
      result: "ok",
    });
    emitAssistantMessageEnd(emit, messageText);

    await flushAsyncCallbacks();
    expect(onBlockReply).not.toHaveBeenCalled();
  });
  it("does not suppress message_end replies when message tool reports error", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "Please retry the send.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-err",
      message: messageText,
      result: { details: { status: "error" } },
    });
    emitAssistantMessageEnd(emit, messageText);

    await flushAsyncCallbacks();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
  it("clears block reply state on message_start", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("text_end");
    emitAssistantTextEndBlock(emit, "OK");
    await flushAsyncCallbacks();
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // New assistant message with identical output should still emit.
    emitAssistantTextEndBlock(emit, "OK");
    await flushAsyncCallbacks();
    expect(onBlockReply).toHaveBeenCalledTimes(2);
  });
});
