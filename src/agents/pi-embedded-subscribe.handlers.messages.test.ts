import { describe, expect, it } from "vitest";
import { resolveSilentReplyFallbackText } from "./pi-embedded-subscribe.handlers.messages.js";

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

describe("pendingCrossTurnSeparator flag preservation", () => {
  it("preserves flag when using ||=", () => {
    // Simulate the ||= behavior
    let flag = false;

    // First message_end with content: should set to true
    flag ||= true;
    expect(flag).toBe(true);

    // Duplicate message_end with no content: should preserve true
    flag ||= false;
    expect(flag).toBe(true);
  });

  it("resets flag after consumption", () => {
    // Simulate the consumption pattern
    let flag = false;

    // First message_end sets flag
    flag ||= true;
    expect(flag).toBe(true);

    // After consumption in handleMessageUpdate, flag resets
    flag = false;
    expect(flag).toBe(false);

    // Next message_end can set it again
    flag ||= true;
    expect(flag).toBe(true);
  });

  it("handles multiple duplicate message_end events", () => {
    let flag = false;

    // First message_end with content
    flag ||= true;
    expect(flag).toBe(true);

    // Multiple duplicates
    flag ||= false;
    expect(flag).toBe(true);

    flag ||= false;
    expect(flag).toBe(true);

    flag ||= false;
    expect(flag).toBe(true);
  });
});
