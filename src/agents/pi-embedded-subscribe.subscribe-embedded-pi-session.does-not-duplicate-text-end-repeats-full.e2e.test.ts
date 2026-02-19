import { describe, expect, it, vi } from "vitest";
import {
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  it("does not duplicate when text_end repeats full content", () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Good morning!" });
    emitAssistantTextEnd({ emit, content: "Good morning!" });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Good morning!"]);
  });
  it("does not duplicate block chunks when text_end repeats full content", () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: {
        minChars: 5,
        maxChars: 40,
        breakPreference: "newline",
      },
    });

    const fullText = "First line\nSecond line\nThird line\n";

    emitAssistantTextDelta({ emit, delta: fullText });

    const callsAfterDelta = onBlockReply.mock.calls.length;
    expect(callsAfterDelta).toBeGreaterThan(0);

    emitAssistantTextEnd({ emit, content: fullText });

    expect(onBlockReply).toHaveBeenCalledTimes(callsAfterDelta);
  });
});
