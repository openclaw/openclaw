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
    messageProvider: "bluebubbles",
    originatingTo: "+14155592088",
    onBlockReply,
    blockReplyBreak,
  });
  return { emit, onBlockReply };
}

async function emitMessageToolLifecycle(params: {
  emit: (evt: unknown) => void;
  toolCallId: string;
  to?: string;
  message: string;
  result: unknown;
}) {
  params.emit({
    type: "tool_execution_start",
    toolName: "message",
    toolCallId: params.toolCallId,
    args: { action: "send", to: params.to ?? "+1555", message: params.message },
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

describe("subscribeEmbeddedPiSession", () => {
  it("suppresses message_end block replies when the message tool already sent", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "This is the answer.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-1",
      to: "+14155592088",
      message: messageText,
      result: "ok",
    });
    emitAssistantMessageEnd(emit, messageText);

    expect(onBlockReply).not.toHaveBeenCalled();
  });
  it("does not suppress message_end replies when message tool reports error", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "Please retry the send.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-err",
      to: "+14155592088",
      message: messageText,
      result: { details: { status: "error" } },
    });
    emitAssistantMessageEnd(emit, messageText);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
  it("does not suppress message_end replies when message tool sent to a different target", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "Done - I replied in Juan chat.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-other-chat",
      to: "any;+;c9e1c78203f74195b1db32e57529fb6a",
      message: messageText,
      result: "ok",
    });
    emitAssistantMessageEnd(emit, messageText);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
  it("does not suppress text_end block replies when message tool sent to a different target", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("text_end");

    const messageText = "Done - I replied in Juan chat.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-other-chat-text-end",
      to: "any;+;c9e1c78203f74195b1db32e57529fb6a",
      message: messageText,
      result: "ok",
    });
    emitAssistantTextEndBlock(emit, messageText);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
  it("clears block reply state on message_start", () => {
    const { emit, onBlockReply } = createBlockReplyHarness("text_end");
    emitAssistantTextEndBlock(emit, "OK");
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // New assistant message with identical output should still emit.
    emitAssistantTextEndBlock(emit, "OK");
    expect(onBlockReply).toHaveBeenCalledTimes(2);
  });
});
