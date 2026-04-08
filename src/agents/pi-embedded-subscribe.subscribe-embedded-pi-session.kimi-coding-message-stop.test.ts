import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession KimiCodingPlan workaround", () => {
  it("synthesizes message_end when message_start arrives before previous message_end", () => {
    const onBlockReply = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      onAssistantMessageStart,
      blockReplyBreak: "message_end",
    });

    // First message starts
    emit({ type: "message_start", message: { role: "assistant" } });
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);

    // First message has some text
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "First message" },
    });

    // Second message starts WITHOUT the first message having ended
    // This simulates the KimiCodingPlan malformed SSE stream issue
    emit({ type: "message_start", message: { role: "assistant" } });

    // The workaround should synthesize a message_end for the first message
    // and then start the second message
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(2);

    // Second message content
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Second message" },
    });

    // End second message properly
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Second message" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    // Both messages should be in assistantTexts in order
    expect(subscription.assistantTexts).toEqual(["First message", "Second message"]);
  });

  it("properly tracks inAssistantMessage state through message lifecycle", () => {
    const onAssistantMessageStart = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onAssistantMessageStart,
      blockReplyBreak: "message_end",
    });

    // Message starts
    emit({ type: "message_start", message: { role: "assistant" } });
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);

    // Message ends
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    // New message starts - should NOT synthesize message_end since previous ended properly
    emit({ type: "message_start", message: { role: "assistant" } });
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(2);
    expect(subscription.assistantTexts).toEqual(["Hello"]);
  });

  it("ignores stale real message_end after a synthetic close", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "First message" },
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Second message" },
    });

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "First message" }],
      } as AssistantMessage,
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Second message" }],
      } as AssistantMessage,
    });

    expect(subscription.assistantTexts).toEqual(["First message", "Second message"]);
  });
});
