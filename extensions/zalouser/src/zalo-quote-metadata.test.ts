import { describe, expect, it } from "vitest";
import type { ZaloInboundMessage } from "./types.js";
import { toInboundMessage } from "./zalo-js.js";

describe("Zalo quote metadata extraction (#86851)", () => {
  it("should extract quotedGlobalMsgId from data.quote", () => {
    const mockMessage = {
      idFrom: "123456789",
      idTo: "987654321",
      dTime: Date.now(),
      action: 0,
      content: {
        title: "Test message",
      },
      data: {
        quote: {
          globalMsgId: "123456789012345",
          ownerId: "owner123",
          msg: "Previous message content",
        },
      },
    };

    const result = toInboundMessage(mockMessage as any, "ownUserId");

    expect(result.quotedGlobalMsgId).toBe("123456789012345");
    expect(result.quotedOwnerId).toBe("owner123");
    expect(result.quotedBody).toBe("Previous message content");
  });

  it("should return undefined when data.quote is missing", () => {
    const mockMessage = {
      idFrom: "123456789",
      idTo: "987654321",
      dTime: Date.now(),
      action: 0,
      content: {
        title: "Test message",
      },
      data: {},
    };

    const result = toInboundMessage(mockMessage as any, "ownUserId");

    expect(result.quotedGlobalMsgId).toBeUndefined();
    expect(result.quotedOwnerId).toBeUndefined();
    expect(result.quotedBody).toBeUndefined();
  });

  it("should return undefined when data.quote.globalMsgId is empty", () => {
    const mockMessage = {
      idFrom: "123456789",
      idTo: "987654321",
      dTime: Date.now(),
      action: 0,
      content: {
        title: "Test message",
      },
      data: {
        quote: {
          globalMsgId: "",
          ownerId: "owner123",
          msg: "",
        },
      },
    };

    const result = toInboundMessage(mockMessage as any, "ownUserId");

    expect(result.quotedGlobalMsgId).toBeUndefined();
    expect(result.quotedOwnerId).toBeUndefined();
    expect(result.quotedBody).toBeUndefined();
  });

  it("should extract quote metadata alongside existing mention detection", () => {
    const mockMessage = {
      idFrom: "123456789",
      idTo: "987654321",
      dTime: Date.now(),
      action: 0,
      content: {
        title: "Test message @mentioned_user",
      },
      data: {
        quote: {
          globalMsgId: "quoted123",
          ownerId: "owner456",
          msg: "Quoted content",
        },
      },
    };

    const result = toInboundMessage(mockMessage as any, "ownUserId");

    // Quote metadata should be extracted
    expect(result.quotedGlobalMsgId).toBe("quoted123");
    expect(result.quotedOwnerId).toBe("owner456");
    expect(result.quotedBody).toBe("Quoted content");

    // Existing mention detection should still work
    expect(result.implicitMention).toBeDefined();
  });
});

describe("ZaloInboundMessage type validation", () => {
  it("should include quote metadata fields in ZaloInboundMessage type", () => {
    const message: ZaloInboundMessage = {
      senderId: "123",
      senderName: "Test User",
      content: "Test",
      timestamp: Date.now(),
      chatId: "chat123",
      chatName: "Test Chat",
      isGroup: false,
      implicitMention: false,
      quotedGlobalMsgId: "quotedId123",
      quotedOwnerId: "ownerId456",
      quotedBody: "Quoted message body",
      raw: {},
    };

    expect(message.quotedGlobalMsgId).toBe("quotedId123");
    expect(message.quotedOwnerId).toBe("ownerId456");
    expect(message.quotedBody).toBe("Quoted message body");
  });
});