import { describe, expect, it } from "vitest";
import { normalizeWebhookMessage, normalizeWebhookReaction } from "./monitor-normalize.js";

function createFallbackDmPayload(overrides: Record<string, unknown> = {}) {
  return {
    guid: "msg-1",
    isGroup: false,
    isFromMe: false,
    handle: null,
    chatGuid: "iMessage;-;+15551234567",
    ...overrides,
  };
}

describe("normalizeWebhookMessage", () => {
  it("falls back to DM chatGuid handle when sender handle is missing", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: createFallbackDmPayload({
        text: "hello",
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.senderIdExplicit).toBe(false);
    expect(result?.chatGuid).toBe("iMessage;-;+15551234567");
  });

  it("marks explicit sender handles as explicit identity", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-explicit-1",
        text: "hello",
        isGroup: false,
        isFromMe: true,
        handle: { address: "+15551234567" },
        chatGuid: "iMessage;-;+15551234567",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.senderIdExplicit).toBe(true);
  });

  it("preserves group messages when sender handle is missing", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello group",
        isGroup: true,
        isFromMe: false,
        handle: null,
        chatGuid: "iMessage;+;chat123456",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("");
    expect(result?.senderIdExplicit).toBe(false);
    expect(result?.isGroup).toBe(true);
  });

  it("drops group messages with missing sender and no chat identity", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-no-chat-1",
        text: "hello group",
        isGroup: true,
        isFromMe: false,
        handle: null,
      },
    });

    expect(result).toBeNull();
  });

  it("falls back to me for fromMe messages when sender handle is missing", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-fromme-1",
        text: "hello group",
        isGroup: true,
        isFromMe: true,
        handle: null,
        chatGuid: "iMessage;+;chat123456",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("me");
    expect(result?.senderIdExplicit).toBe(false);
  });

  it("accepts array-wrapped payload data", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: [
        {
          guid: "msg-1",
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
  });
});

describe("normalizeWebhookReaction", () => {
  it("falls back to DM chatGuid handle when reaction sender handle is missing", () => {
    const result = normalizeWebhookReaction({
      type: "updated-message",
      data: createFallbackDmPayload({
        guid: "msg-2",
        associatedMessageGuid: "p:0/msg-1",
        associatedMessageType: 2000,
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.senderIdExplicit).toBe(false);
    expect(result?.messageId).toBe("p:0/msg-1");
    expect(result?.action).toBe("added");
  });

  it("preserves group reactions when sender handle is missing", () => {
    const result = normalizeWebhookReaction({
      type: "updated-message",
      data: {
        guid: "msg-2",
        associatedMessageGuid: "p:0/msg-1",
        associatedMessageType: 2000,
        isGroup: true,
        isFromMe: false,
        handle: null,
        chatGuid: "iMessage;+;chat123456",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("");
    expect(result?.senderIdExplicit).toBe(false);
    expect(result?.messageId).toBe("p:0/msg-1");
  });

  it("drops group reactions with missing sender and no chat identity", () => {
    const result = normalizeWebhookReaction({
      type: "updated-message",
      data: {
        guid: "msg-no-chat-2",
        associatedMessageGuid: "p:0/msg-1",
        associatedMessageType: 2000,
        isGroup: true,
        isFromMe: false,
        handle: null,
      },
    });

    expect(result).toBeNull();
  });
});
