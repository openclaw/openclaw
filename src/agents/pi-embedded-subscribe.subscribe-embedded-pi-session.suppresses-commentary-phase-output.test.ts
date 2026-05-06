import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

type AssistantMessageWithPhase = AssistantMessage & {
  phase?: "commentary" | "final_answer";
};

describe("subscribeEmbeddedPiSession", () => {
  it("suppresses assistant messages that continue into tool use without phase metadata", () => {
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      onPartialReply,
      blockReplyBreak: "message_end",
    });

    const toolUseMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "I'll check this now." },
        { type: "toolCall", id: "call-1", name: "read", input: { path: "README.md" } },
      ],
      stopReason: "toolUse",
    } as AssistantMessage;

    emit({ type: "message_start", message: toolUseMessage });
    emit({
      type: "message_update",
      message: toolUseMessage,
      assistantMessageEvent: { type: "text_delta", delta: "I'll check this now." },
    });
    emit({ type: "message_end", message: toolUseMessage });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual([]);
  });

  it("suppresses commentary-phase assistant messages before tool use", () => {
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      onPartialReply,
      blockReplyBreak: "message_end",
    });

    const commentaryMessage = {
      role: "assistant",
      phase: "commentary",
      content: [{ type: "text", text: "Need send." }],
      stopReason: "toolUse",
    } as AssistantMessageWithPhase;

    emit({ type: "message_start", message: commentaryMessage });
    emit({ type: "message_end", message: commentaryMessage });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual([]);
  });

  it("suppresses commentary when phase is only present in textSignature metadata", () => {
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      onPartialReply,
      blockReplyBreak: "message_end",
    });

    const commentaryMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Need send.",
          textSignature: JSON.stringify({ v: 1, id: "msg_sig", phase: "commentary" }),
        },
      ],
      stopReason: "toolUse",
    } as AssistantMessage;

    emit({ type: "message_start", message: commentaryMessage });
    emit({
      type: "message_update",
      message: commentaryMessage,
      assistantMessageEvent: { type: "text_delta", delta: "Need send." },
    });
    emit({ type: "message_end", message: commentaryMessage });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual([]);
  });

  it.each(["message_end", "text_end"] as const)(
    "does not flush buffered commentary text before tool execution when phase arrives at text_end (%s)",
    (blockReplyBreak) => {
      const onBlockReply = vi.fn();
      const onPartialReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run",
        onBlockReply,
        onPartialReply,
        blockReplyBreak,
      });

      const commentaryMessage = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      } as AssistantMessage;
      const text = "I'll check this now.";

      const commentaryContent = commentaryMessage.content as unknown as Array<
        Record<string, unknown>
      >;

      emit({ type: "message_start", message: commentaryMessage });
      emit({
        type: "message_update",
        message: commentaryMessage,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: text,
          partial: commentaryMessage,
        },
      });
      commentaryContent[0] = {
        type: "text",
        text,
        textSignature: JSON.stringify({ v: 1, id: "msg_sig", phase: "commentary" }),
      };
      emit({
        type: "message_update",
        message: commentaryMessage,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: text,
          partial: commentaryMessage,
        },
      });
      emit({ type: "tool_execution_start", toolName: "read", toolCallId: "call-1", args: {} });
      commentaryContent.push({
        type: "toolCall",
        id: "call-1",
        name: "read",
        input: { path: "README.md" },
      });
      (commentaryMessage as { stopReason?: string }).stopReason = "toolUse";
      emit({ type: "message_end", message: commentaryMessage });

      expect(onBlockReply).not.toHaveBeenCalled();
      expect(subscription.assistantTexts).toEqual([]);
    },
  );
});
