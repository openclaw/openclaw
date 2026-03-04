import { describe, expect, it, vi } from "vitest";
import {
  createReasoningFinalAnswerMessage,
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("keeps assistantTexts to the final answer when block replies are disabled", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      reasoningMode: "on",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Final " });
    emitAssistantTextDelta({ emit, delta: "answer" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });
  it("suppresses partial replies when reasoning is enabled and block replies are disabled", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      reasoningMode: "on",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Draft " });
    emitAssistantTextDelta({ emit, delta: "reply" });

    expect(onPartialReply).not.toHaveBeenCalled();

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ type: "message_end", message: assistantMessage });
    emitAssistantTextEnd({ emit, content: "Draft reply" });

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });
  it("discards assistant text from tool-use rounds so only final reply is in assistantTexts", () => {
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({ session, runId: "run" });

    // First turn: internal reasoning then tool call (stopReason toolUse).
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({
      emit,
      delta: "User not in registry, creating record. Reading template file.",
    });
    emitAssistantTextEnd({ emit });
    const toolUseMessage = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "User not in registry, creating record. Reading template file." },
        { type: "toolCall", toolCallId: "tc-1", name: "read_template", args: {} },
      ],
    };
    emit({ type: "message_end", message: toolUseMessage });

    expect(subscription.assistantTexts).toEqual([]);

    // Second turn: final reply (no toolUse).
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Here is your reply." });
    emitAssistantTextEnd({ emit });
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Here is your reply." }],
    };
    emit({ type: "message_end", message: finalMessage });

    expect(subscription.assistantTexts).toEqual(["Here is your reply."]);
  });
});
