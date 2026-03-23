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

function emitAssistantMessageEnd(
  emit: (evt: unknown) => void,
  text: string,
  overrides?: Partial<AssistantMessage>,
) {
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    ...overrides,
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
    await Promise.resolve();

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
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
  it("ignores delivery-mirror assistant messages", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    emitAssistantMessageEnd(emit, "Mirrored transcript text", {
      provider: "openclaw",
      model: "delivery-mirror",
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("ignores gateway-injected assistant messages", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    emitAssistantMessageEnd(emit, "Injected transcript text", {
      provider: "openclaw",
      model: "gateway-injected",
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });
  it("does not suppress message_end replies when message tool sent to a different target", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "Done - I replied in a different thread.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-other-chat",
      to: "+14155590123",
      message: messageText,
      result: "ok",
    });
    emitAssistantMessageEnd(emit, messageText);
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
  it("does not suppress text_end block replies when message tool sent to a different target", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("text_end");

    const messageText = "Done - I replied in a different thread.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-other-chat-text-end",
      to: "+14155590123",
      message: messageText,
      result: "ok",
    });
    emitAssistantTextEndBlock(emit, messageText);
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
  it("clears block reply state on message_start", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("text_end");
    emitAssistantTextEndBlock(emit, "OK");
    await Promise.resolve();
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // New assistant message with identical output should still emit.
    emitAssistantTextEndBlock(emit, "OK");
    await Promise.resolve();
    expect(onBlockReply).toHaveBeenCalledTimes(2);
  });
});
