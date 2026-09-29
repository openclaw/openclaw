import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

function ollamaAssistant(text: string, extra?: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: "ollama",
    content: [{ type: "text", text }, ...(extra ?? [])],
  } as unknown as AssistantMessage;
}

function commentarySignature(id: string, text: string): AssistantMessage["content"][number] {
  return {
    type: "text",
    text,
    textSignature: JSON.stringify({ v: 1, id, phase: "commentary" }),
  } as unknown as AssistantMessage["content"][number];
}

function postedText(onBlockReply: ReturnType<typeof vi.fn>): string {
  return onBlockReply.mock.calls.map((call) => call[0]?.text ?? "").join(" ");
}

describe("native Ollama pre-tool narration", () => {
  it("withholds two narrated tool rounds and delivers the final answer exactly once", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-ollama-withhold",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 4, maxChars: 200 },
    });

    onTestFinished(() => subscription.unsubscribe());

    for (const [index, path] of ["README.md", "NOTES.md"].entries()) {
      const narration = `Let me read ${path} before answering.`;
      const toolCall = {
        type: "toolCall" as const,
        id: `tool-${index}`,
        name: "read",
        arguments: { path },
      };
      const unsigned = ollamaAssistant(narration);
      emit({ type: "message_start", message: ollamaAssistant("") });
      emit({
        type: "message_update",
        message: ollamaAssistant(""),
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      });
      emit({
        type: "message_update",
        message: unsigned,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: narration },
      });
      await subscription.waitForPendingEvents();
      expect(onBlockReply).not.toHaveBeenCalled();

      // Native Ollama closes unsigned text before terminal tool classification.
      // Await this boundary so a premature durable flush cannot hide in the queue.
      emit({
        type: "message_update",
        message: unsigned,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: narration,
          partial: unsigned,
        },
      });
      await subscription.waitForPendingEvents();
      expect(onBlockReply).not.toHaveBeenCalled();

      for (const event of [
        {
          type: "toolcall_start",
          partial: ollamaAssistant(narration, [{ ...toolCall, arguments: {} }]),
        },
        {
          type: "toolcall_delta",
          delta: JSON.stringify(toolCall.arguments),
          partial: ollamaAssistant(narration, [toolCall]),
        },
        {
          type: "toolcall_end",
          toolCall,
          partial: ollamaAssistant(narration, [toolCall]),
        },
      ]) {
        emit({
          type: "message_update",
          message: event.partial,
          assistantMessageEvent: { ...event, contentIndex: 1 },
        });
      }
      emit({
        type: "message_end",
        message: {
          ...unsigned,
          stopReason: "toolUse",
          content: [commentarySignature(`commentary-${index}`, narration), toolCall],
        },
      });
      emit({
        type: "tool_execution_start",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        args: toolCall.arguments,
      });
      emit({
        type: "tool_execution_end",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        result: { content: [{ type: "text", text: "File contents" }] },
        isError: false,
      });
      await subscription.waitForPendingEvents();
      expect(onBlockReply).not.toHaveBeenCalled();
    }

    const answer = "Both files are checked.";
    const finalMessage = { ...ollamaAssistant(answer), stopReason: "stop" as const };
    emit({ type: "message_start", message: ollamaAssistant("") });
    emit({
      type: "message_update",
      message: finalMessage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: answer },
    });
    emit({
      type: "message_update",
      message: finalMessage,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: answer,
        partial: finalMessage,
      },
    });
    await subscription.waitForPendingEvents();
    expect(onBlockReply).not.toHaveBeenCalled();
    emit({ type: "message_end", message: finalMessage });
    await subscription.waitForPendingEvents();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text: answer });
  });

  it("delivers a permanent unphased Ollama answer as the final reply", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-ollama-answer",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 4, maxChars: 200 },
    });

    emit({ type: "message_start", message: ollamaAssistant("") });
    emit({
      type: "message_update",
      message: ollamaAssistant("prefix "),
      assistantMessageEvent: { type: "text_delta", delta: "prefix " },
    });
    emit({
      type: "message_update",
      message: ollamaAssistant("prefix suffix"),
      assistantMessageEvent: { type: "text_end", contentIndex: 0, delta: "suffix" },
    });
    emit({ type: "message_end", message: ollamaAssistant("prefix suffix") });

    await subscription.waitForPendingEvents();
    expect(postedText(onBlockReply)).toContain("prefix suffix");
  });

  it("delivers length-limited Ollama output without treating it as commentary", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-ollama-length",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 4, maxChars: 200 },
    });

    emit({ type: "message_start", message: ollamaAssistant("") });
    emit({
      type: "message_update",
      message: ollamaAssistant("Partial answer"),
      assistantMessageEvent: { type: "text_delta", delta: "Partial answer" },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        api: "ollama",
        stopReason: "length",
        content: [{ type: "text", text: "Partial answer" }],
      } as unknown as AssistantMessage,
    });

    await subscription.waitForPendingEvents();
    expect(postedText(onBlockReply)).toContain("Partial answer");
  });
});
