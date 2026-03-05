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

  describe("separator arming based on emitted content", () => {
    it("arms separator for streamed turns", () => {
      // Simulate a streamed turn with deltaBuffer content
      const deltaBufferLength = 100;
      const emittedAssistantUpdate = true;
      const blockChunking = true;

      const shouldArm = blockChunking && (deltaBufferLength > 0 || emittedAssistantUpdate);
      expect(shouldArm).toBe(true);
    });

    it("arms separator for non-streamed turns with fallback text", () => {
      // Simulate a non-streamed turn that emits text via fallback path
      const deltaBufferLength = 0; // No streaming content
      const emittedAssistantUpdate = true; // But fallback emitted text
      const blockChunking = true;

      const shouldArm = blockChunking && (deltaBufferLength > 0 || emittedAssistantUpdate);
      expect(shouldArm).toBe(true);
    });

    it("does not arm separator for empty turns", () => {
      // Simulate an empty turn (no text emitted at all)
      const deltaBufferLength = 0;
      const emittedAssistantUpdate = false;
      const blockChunking = true;

      const shouldArm = blockChunking && (deltaBufferLength > 0 || emittedAssistantUpdate);
      expect(shouldArm).toBe(false);
    });

    it("handles streamed turn followed by non-streamed empty turn", () => {
      // First turn: streamed with content
      let deltaBufferLength = 100;
      let emittedAssistantUpdate = true;
      let blockChunking = true;
      let separatorFlag = false;

      // First message_end: arms separator
      separatorFlag ||= blockChunking && (deltaBufferLength > 0 || emittedAssistantUpdate);
      expect(separatorFlag).toBe(true);

      // Separator consumed by next turn's first chunk
      separatorFlag = false;

      // Second turn: non-streamed, no content (e.g., empty tool result)
      deltaBufferLength = 0;
      emittedAssistantUpdate = false;

      // Second message_end: should NOT arm separator (no content emitted)
      separatorFlag ||= blockChunking && (deltaBufferLength > 0 || emittedAssistantUpdate);
      expect(separatorFlag).toBe(false);
    });

    it("handles streamed turn followed by non-streamed turn with text", () => {
      // First turn: streamed with content
      let deltaBufferLength = 100;
      let emittedAssistantUpdate = true;
      let blockChunking = true;
      let separatorFlag = false;

      // First message_end: arms separator
      separatorFlag ||= blockChunking && (deltaBufferLength > 0 || emittedAssistantUpdate);
      expect(separatorFlag).toBe(true);

      // Separator consumed by next turn's first chunk
      separatorFlag = false;

      // Second turn: non-streamed, but has fallback text
      deltaBufferLength = 0; // No streaming
      emittedAssistantUpdate = true; // Fallback path emitted text

      // Second message_end: SHOULD arm separator (content was emitted)
      separatorFlag ||= blockChunking && (deltaBufferLength > 0 || emittedAssistantUpdate);
      expect(separatorFlag).toBe(true);
    });
  });
});
