import { describe, expect, it } from "vitest";
import {
  resolveSilentReplyFallbackText,
  resolveThinkingOnlyFallbackText,
} from "./pi-embedded-subscribe.handlers.messages.js";

describe("resolveSilentReplyFallbackText", () => {
  it("replaces NO_REPLY with latest messaging tool text when available", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: ["first", "final delivered text"],
      }),
    ).toBe("final delivered text");
  });

  it("keeps original text when response is not NO_REPLY", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "normal assistant reply",
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("normal assistant reply");
  });

  it("keeps NO_REPLY when there is no messaging tool text to mirror", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [],
      }),
    ).toBe("NO_REPLY");
  });
});

describe("resolveThinkingOnlyFallbackText", () => {
  it("falls back to extracted thinking when assistant text is empty", () => {
    expect(
      resolveThinkingOnlyFallbackText({
        text: "",
        hasMedia: false,
        extractedThinking: "final answer text",
        includeReasoning: false,
        streamReasoning: false,
      }),
    ).toBe("final answer text");
  });

  it("does not replace existing assistant text", () => {
    expect(
      resolveThinkingOnlyFallbackText({
        text: "assistant reply",
        hasMedia: false,
        extractedThinking: "thinking text",
        includeReasoning: false,
        streamReasoning: false,
      }),
    ).toBe("assistant reply");
  });

  it("does not fallback when reasoning output is explicitly enabled", () => {
    expect(
      resolveThinkingOnlyFallbackText({
        text: "",
        hasMedia: false,
        extractedThinking: "thinking text",
        includeReasoning: true,
        streamReasoning: false,
      }),
    ).toBe("");
  });
});
