import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  it("emits block replies on text_end and does not duplicate on message_end", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = onBlockReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello block");
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });
  it("does not duplicate when message_end flushes and a late text_end arrives", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });

    emitAssistantTextDelta({ emit, delta: "Hello block" });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    // Simulate a provider that ends the message without emitting text_end.
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    // Some providers can still emit a late text_end; this must not re-emit.
    emitAssistantTextEnd({ emit, content: "Hello block" });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });
});
