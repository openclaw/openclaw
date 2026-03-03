import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

function createBlockReplyHarness(params: {
  blockReplyBreak: "message_end" | "text_end";
  messageProvider?: string;
  originatingTo?: string;
}) {
  const { session, emit } = createStubSessionHarness();
  const onBlockReply = vi.fn();
  subscribeEmbeddedPiSession({
    session,
    runId: "run",
    messageProvider: params.messageProvider ?? "bluebubbles",
    originatingTo: params.originatingTo ?? "+14155592088",
    onBlockReply,
    blockReplyBreak: params.blockReplyBreak,
  });
  return { emit, onBlockReply };
}

async function emitMessageToolLifecycle(params: {
  emit: (evt: unknown) => void;
  toolCallId: string;
  to?: string;
  omitTo?: boolean;
  message: string;
  result: unknown;
}) {
  const args: Record<string, unknown> = {
    action: "send",
    message: params.message,
  };
  if (!params.omitTo) {
    args.to = params.to ?? "+1555";
  }
  params.emit({
    type: "tool_execution_start",
    toolName: "message",
    toolCallId: params.toolCallId,
    args,
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
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "message_end" });

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
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "message_end" });

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
  it("suppresses message_end block replies when message tool infers target without to/target args", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "message_end" });

    const messageText = "Done - sent from inferred channel context.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-inferred-target",
      omitTo: true,
      message: messageText,
      result: "ok",
    });
    emitAssistantMessageEnd(emit, messageText);

    expect(onBlockReply).not.toHaveBeenCalled();
  });
  it("does not suppress message_end replies when message tool sent to a different target", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "message_end" });

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
  it("suppresses message_end when inferred-target send exists alongside explicit off-target send", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "message_end" });

    const messageText = "Done - sent from inferred channel context.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-inferred-target-mixed-message-end",
      omitTo: true,
      message: messageText,
      result: "ok",
    });
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-explicit-other-chat-message-end",
      to: "any;+;c9e1c78203f74195b1db32e57529fb6a",
      message: "Explicit send in another chat.",
      result: "ok",
    });
    emitAssistantMessageEnd(emit, messageText);

    expect(onBlockReply).not.toHaveBeenCalled();
  });
  it("does not suppress message_end for explicit off-target text when inferred-target text differs", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "message_end" });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-inferred-target-mixed-message-end-different-text",
      omitTo: true,
      message: "Sent to current chat via inferred target.",
      result: "ok",
    });
    const offTargetText = "Sent explicitly to another chat.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-explicit-other-chat-message-end-different-text",
      to: "any;+;c9e1c78203f74195b1db32e57529fb6a",
      message: offTargetText,
      result: "ok",
    });
    emitAssistantMessageEnd(emit, offTargetText);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
  it("suppresses text_end block replies when message tool infers target without to/target args", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "text_end" });

    const messageText = "Done - sent from inferred channel context.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-inferred-target-text-end",
      omitTo: true,
      message: messageText,
      result: "ok",
    });
    emitAssistantTextEndBlock(emit, messageText);

    expect(onBlockReply).not.toHaveBeenCalled();
  });
  it("does not suppress text_end block replies when message tool sent to a different target", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "text_end" });

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
  it("suppresses text_end when inferred-target send exists alongside explicit off-target send", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "text_end" });

    const messageText = "Done - sent from inferred channel context.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-inferred-target-mixed-text-end",
      omitTo: true,
      message: messageText,
      result: "ok",
    });
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-explicit-other-chat-text-end",
      to: "any;+;c9e1c78203f74195b1db32e57529fb6a",
      message: "Explicit send in another chat.",
      result: "ok",
    });
    emitAssistantTextEndBlock(emit, messageText);

    expect(onBlockReply).not.toHaveBeenCalled();
  });
  it("does not suppress text_end for explicit off-target text when inferred-target text differs", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "text_end" });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-inferred-target-mixed-text-end-different-text",
      omitTo: true,
      message: "Sent to current chat via inferred target.",
      result: "ok",
    });
    const offTargetText = "Sent explicitly to another chat.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-explicit-other-chat-text-end-different-text",
      to: "any;+;c9e1c78203f74195b1db32e57529fb6a",
      message: offTargetText,
      result: "ok",
    });
    emitAssistantTextEndBlock(emit, offTargetText);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });
  it("clears block reply state on message_start", () => {
    const { emit, onBlockReply } = createBlockReplyHarness({ blockReplyBreak: "text_end" });
    emitAssistantTextEndBlock(emit, "OK");
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // New assistant message with identical output should still emit.
    emitAssistantTextEndBlock(emit, "OK");
    expect(onBlockReply).toHaveBeenCalledTimes(2);
  });

  it("suppresses message_end when telegram auto-threading targets current topic without explicit topic in to", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({
      blockReplyBreak: "message_end",
      messageProvider: "telegram",
      originatingTo: "telegram:group:-100123:topic:77",
    });

    const messageText = "Sent into current telegram topic.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-telegram-topic-message-end",
      to: "-100123",
      message: messageText,
      result: "ok",
    });
    emitAssistantMessageEnd(emit, messageText);

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("suppresses text_end when telegram auto-threading targets current topic without explicit topic in to", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness({
      blockReplyBreak: "text_end",
      messageProvider: "telegram",
      originatingTo: "telegram:group:-100123:topic:77",
    });

    const messageText = "Sent into current telegram topic.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-telegram-topic-text-end",
      to: "-100123",
      message: messageText,
      result: "ok",
    });
    emitAssistantTextEndBlock(emit, messageText);

    expect(onBlockReply).not.toHaveBeenCalled();
  });
});
