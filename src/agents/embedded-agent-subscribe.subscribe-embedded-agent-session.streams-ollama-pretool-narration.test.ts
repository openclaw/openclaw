import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
import {
  createTextEndBlockReplyHarness,
  emitToolRun,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function ollamaAssistant(text: string, extra?: AssistantMessage["content"]): AssistantMessage {
  return makeAgentAssistantMessage({
    api: "ollama",
    provider: "ollama",
    content: [{ type: "text", text }, ...(extra ?? [])],
  });
}

function setup(runId: string) {
  const onBlockReply = vi.fn();
  const { emit, subscription } = createTextEndBlockReplyHarness({
    runId,
    onBlockReply,
    blockReplyChunking: { minChars: 4, maxChars: 200 },
  });
  onTestFinished(() => subscription.unsubscribe());
  return {
    emit,
    subscription,
    onBlockReply,
    texts: () => onBlockReply.mock.calls.map(([payload]) => payload.text),
    update: (message: AssistantMessage, assistantMessageEvent: object) =>
      emit({ type: "message_update", message, assistantMessageEvent }),
  };
}

describe("native Ollama pre-tool narration", () => {
  it("streams two narrated tool rounds and the final answer exactly once", async () => {
    const { emit, update, subscription, texts } = setup("run-ollama-stream");
    const expected: string[] = [];

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
      update(ollamaAssistant(""), { type: "text_start", contentIndex: 0 });
      update(unsigned, { type: "text_delta", contentIndex: 0, delta: narration });
      await subscription.waitForPendingEvents();
      expected.push(narration);
      expect(texts()).toEqual(expected);

      // Native Ollama keeps the same unsigned text through the tool boundary.
      update(unsigned, {
        type: "text_end",
        contentIndex: 0,
        content: narration,
        partial: unsigned,
      });
      await subscription.waitForPendingEvents();
      expect(texts()).toEqual(expected);

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
        update(event.partial, { ...event, contentIndex: 1 });
      }
      emit({
        type: "message_end",
        message: { ...ollamaAssistant(narration, [toolCall]), stopReason: "toolUse" },
      });
      emitToolRun({
        emit,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        args: toolCall.arguments,
        result: { content: [{ type: "text", text: "File contents" }] },
        isError: false,
      });
      await subscription.waitForPendingEvents();
      expect(texts()).toEqual(expected);
    }

    const answer = "Both files are checked.";
    const finalMessage = { ...ollamaAssistant(answer), stopReason: "stop" as const };
    emit({ type: "message_start", message: ollamaAssistant("") });
    update(finalMessage, { type: "text_delta", contentIndex: 0, delta: answer });
    update(finalMessage, {
      type: "text_end",
      contentIndex: 0,
      content: answer,
      partial: finalMessage,
    });
    await subscription.waitForPendingEvents();
    expected.push(answer);
    expect(texts()).toEqual(expected);
    emit({ type: "message_end", message: finalMessage });
    await subscription.waitForPendingEvents();
    expect(texts()).toEqual(expected);
  });

  it.each(["stop", "length"] as const)(
    "delivers unphased text before reasoning exactly once at %s",
    async (stopReason) => {
      const { emit, update, subscription, onBlockReply, texts } = setup("run-ollama-answer");
      const answer = "Visible answer";
      emit({ type: "message_start", message: ollamaAssistant("") });
      update(ollamaAssistant(answer), { type: "text_delta", contentIndex: 0, delta: answer });
      const finalMessage = { ...ollamaAssistant(answer), stopReason };
      finalMessage.content.unshift({ type: "thinking", thinking: "Late reasoning" });
      update(finalMessage, { type: "thinking_delta", contentIndex: 0, delta: "Late reasoning" });
      update(finalMessage, { type: "text_end", contentIndex: 1, content: answer });
      await subscription.waitForPendingEvents();
      expect(texts()).toEqual([answer]);
      emit({ type: "message_end", message: finalMessage });
      await subscription.waitForPendingEvents();
      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text: answer });
    },
  );
});
