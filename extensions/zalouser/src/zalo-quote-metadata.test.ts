import { describe, expect, it } from "vitest";
import type { ZaloInboundMessage } from "./types.js";

describe("ZaloInboundMessage quote metadata fields (#86851)", () => {
  it("should include quotedGlobalMsgId, quotedOwnerId, quotedBody in type", () => {
    const message: ZaloInboundMessage = {
      threadId: "thread123",
      isGroup: false,
      senderId: "sender123",
      content: "Test message",
      timestampMs: Date.now(),
      implicitMention: false,
      quotedGlobalMsgId: "quotedGlobal123",
      quotedOwnerId: "owner456",
      quotedBody: "Quoted message body",
      raw: {},
    };

    expect(message.quotedGlobalMsgId).toBe("quotedGlobal123");
    expect(message.quotedOwnerId).toBe("owner456");
    expect(message.quotedBody).toBe("Quoted message body");
  });

  it("should allow optional quote fields to be undefined", () => {
    const message: ZaloInboundMessage = {
      threadId: "thread123",
      isGroup: false,
      senderId: "sender123",
      content: "Test message",
      timestampMs: Date.now(),
      raw: {},
    };

    expect(message.quotedGlobalMsgId).toBeUndefined();
    expect(message.quotedOwnerId).toBeUndefined();
    expect(message.quotedBody).toBeUndefined();
  });

  it("should validate quote metadata fields are optional strings", () => {
    const messageWithQuotes: ZaloInboundMessage = {
      threadId: "thread123",
      isGroup: false,
      senderId: "sender123",
      content: "Reply with quote",
      timestampMs: Date.now(),
      quotedGlobalMsgId: "msgId789",
      quotedOwnerId: "userId789",
      quotedBody: "Original quoted content",
      raw: {},
    };

    expect(typeof messageWithQuotes.quotedGlobalMsgId).toBe("string");
    expect(typeof messageWithQuotes.quotedOwnerId).toBe("string");
    expect(typeof messageWithQuotes.quotedBody).toBe("string");
  });
});