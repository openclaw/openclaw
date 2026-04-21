import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

/**
 * Regression test for #69410: Custom provider returns valid content but agent payloads=0.
 *
 * Scenario: A custom OpenAI-compatible provider sends text via streaming text_delta events,
 * but does NOT emit text_end (or blockReplyBreak is message_end). The text is accumulated
 * in deltaBuffer but never flushed to assistantTexts before message_end, so the final
 * text delivered at message_end should still be pushed to assistantTexts.
 */
describe("subscribeEmbeddedPiSession — custom provider payloads regression", () => {
  it("populates assistantTexts when text arrives via message_end without prior text_end flush", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      // blockReplyBreak defaults to "text_end" — no text_end flush will happen,
      // so text arrives only at message_end via extractAssistantVisibleText
      blockReplyBreak: "text_end",
    });

    const assistantMessage: AssistantMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "OK" }],
    };

    emit({ type: "message_start", message: assistantMessage });

    // Simulate streaming: text_delta events accumulate in deltaBuffer but blockReplyBreak="text_end"
    // means nothing gets flushed until message_end
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "O", partial: assistantMessage },
      message: { ...assistantMessage },
    });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "K", partial: assistantMessage },
      message: { ...assistantMessage },
    });

    emit({ type: "message_end", message: assistantMessage });

    // assistantTexts must contain "OK" — the text delivered at message_end should be
    // captured by finalizeAssistantTexts even when onBlockReply is set and no text_end
    // flush occurred
    expect(subscription.assistantTexts).toContain("OK");
  });

  it("populates assistantTexts at message_end with blockReplyBreak=message_end", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    const assistantMessage: AssistantMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Hello world" }],
    };

    emit({ type: "message_start", message: assistantMessage });
    // Simulate streaming with small deltas
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello ", partial: assistantMessage },
      message: { ...assistantMessage },
    });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world", partial: assistantMessage },
      message: { ...assistantMessage },
    });
    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toContain("Hello world");
  });

  it("does not duplicate text already added via streaming", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    const assistantMessage: AssistantMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "OK" }],
    };

    emit({ type: "message_start", message: assistantMessage });

    // Emit text_end — this triggers flushBlockReplyBuffer which calls emitBlockChunk → pushAssistantText
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "OK", partial: assistantMessage },
      message: { ...assistantMessage },
    });

    // message_end delivers the same text
    emit({ type: "message_end", message: assistantMessage });

    // Should have "OK" once, not twice
    expect(subscription.assistantTexts.filter((t) => t === "OK")).toHaveLength(1);
  });
});
