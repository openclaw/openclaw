import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("keeps the final assistant text when preview callbacks are enabled but block replies are disabled", () => {
    const { session, emit } = createStubSessionHarness();
    const onPartialReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onPartialReply,
      blockReplyChunking: { minChars: 50, maxChars: 200 },
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Draft " });
    emitAssistantTextDelta({ emit, delta: "preview" });

    expect(onPartialReply).toHaveBeenCalled();

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final delivered answer" }],
      },
    });
    emitAssistantTextEnd({ emit, content: "Draft preview" });

    expect(subscription.assistantTexts).toEqual(["Final delivered answer"]);
  });
});
