import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function ollamaAssistant(text: string, extra?: AssistantMessage["content"]): AssistantMessage {
  return makeAgentAssistantMessage({
    api: "ollama",
    provider: "ollama",
    content: [{ type: "text", text }, ...(extra ?? [])],
  });
}

function commentarySignature(id: string, text: string): AssistantMessage["content"][number] {
  return {
    type: "text",
    text,
    textSignature: JSON.stringify({ v: 1, id, phase: "commentary" }),
  };
}

describe("native Ollama pre-tool narration", () => {
  it("withholds two narrated tool rounds and delivers the final answer exactly once", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session,
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

  it.each(["stop", "length"] as const)(
    "delivers unphased text before reasoning exactly once at %s",
    async (stopReason) => {
      const { session, emit } = createStubSessionHarness();
      const onBlockReply = vi.fn();
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: "run-ollama-answer",
        onBlockReply,
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 4, maxChars: 200 },
      });
      onTestFinished(() => subscription.unsubscribe());
      const answer = "Visible answer";
      emit({ type: "message_start", message: ollamaAssistant("") });
      emit({
        type: "message_update",
        message: ollamaAssistant(answer),
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: answer },
      });
      const finalMessage = {
        ...ollamaAssistant(answer),
        content: [
          { type: "thinking" as const, thinking: "Late reasoning" },
          { type: "text" as const, text: answer },
        ],
        stopReason,
      };
      emit({
        type: "message_update",
        message: finalMessage,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Late reasoning" },
      });
      emit({
        type: "message_update",
        message: finalMessage,
        assistantMessageEvent: { type: "text_end", contentIndex: 1, content: answer },
      });
      await subscription.waitForPendingEvents();
      expect(onBlockReply).not.toHaveBeenCalled();
      emit({ type: "message_end", message: finalMessage });
      await subscription.waitForPendingEvents();
      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text: answer });
    },
  );
});
