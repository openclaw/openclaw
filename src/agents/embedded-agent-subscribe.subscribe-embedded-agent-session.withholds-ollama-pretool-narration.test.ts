import { describe, expect, it, vi } from "vitest";
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
  it("withholds unsigned pre-tool narration from durable block replies", () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-ollama-withhold",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 4, maxChars: 200 },
    });

    const narration = "Let me read the file before answering.";
    emit({ type: "message_start", message: ollamaAssistant("") });
    emit({
      type: "message_update",
      message: ollamaAssistant(narration),
      assistantMessageEvent: { type: "text_delta", delta: narration },
    });
    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: { path: "README.md" },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        api: "ollama",
        stopReason: "toolUse",
        content: [
          commentarySignature("commentary-0-abc", narration),
          { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
        ],
      } as unknown as AssistantMessage,
    });

    expect(postedText(onBlockReply)).not.toContain("Let me read the file");
  });

  it("delivers a permanent unphased Ollama answer as the final reply", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedAgentSession({
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

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalled());
    expect(postedText(onBlockReply)).toContain("prefix suffix");
  });

  it("delivers length-limited Ollama output without treating it as commentary", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedAgentSession({
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

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalled());
    expect(postedText(onBlockReply)).toContain("Partial answer");
  });
});
