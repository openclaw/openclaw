import { describe, expect, it } from "vitest";
import { resolveAssistantTextChunk } from "./embedded-agent-subscribe.handlers.messages.stream.js";

describe("resolveAssistantTextChunk", () => {
  it("appends nothing when text_end resends divergent full content", () => {
    // Streamed deltas accumulated "Hello word"; the provider's resent final
    // content diverges ("Hello world"). Appending the full resend would
    // duplicate the tail in the user-visible reply ("Hello wordHello world").
    expect(
      resolveAssistantTextChunk({
        evtType: "text_end",
        delta: "",
        content: "Hello world",
        accumulatedText: "Hello word",
      }),
    ).toBe("");
  });
});
