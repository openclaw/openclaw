import { describe, expect, it } from "vitest";
import { normalizeWebhookMessage, normalizeWebhookReaction } from "./monitor-normalize.js";

describe("normalizeWebhookMessage", () => {
  it("falls back to DM chatGuid handle when sender handle is missing", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        isGroup: false,
        isFromMe: false,
        handle: null,
        chatGuid: "iMessage;-;+15551234567",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.chatGuid).toBe("iMessage;-;+15551234567");
  });

  it("does not infer sender from group chatGuid when sender handle is missing", () => {
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

    expect(result).toBeNull();
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

describe("isFromMe string coercion", () => {
  it("treats isFromMe=true (boolean) as fromMe", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        isGroup: false,
        isFromMe: true,
        handle: { address: "+15551234567" },
        chatGuid: "iMessage;-;+15551234567",
      },
    });
    expect(result?.fromMe).toBe(true);
  });

  it('treats isFromMe="true" (string) as fromMe', () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        isGroup: false,
        isFromMe: "true",
        handle: { address: "+15551234567" },
        chatGuid: "iMessage;-;+15551234567",
      },
    });
    expect(result?.fromMe).toBe(true);
  });

  it('treats isFromMe="1" (string) as fromMe', () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        isGroup: false,
        isFromMe: "1",
        handle: { address: "+15551234567" },
        chatGuid: "iMessage;-;+15551234567",
      },
    });
    expect(result?.fromMe).toBe(true);
  });

  it('treats isFromMe="false" (string) as not fromMe', () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        isGroup: false,
        isFromMe: "false",
        handle: { address: "+15551234567" },
        chatGuid: "iMessage;-;+15551234567",
      },
    });
    expect(result?.fromMe).toBe(false);
  });

  it('treats is_from_me="true" (snake_case string) as fromMe', () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        isGroup: false,
        is_from_me: "true",
        handle: { address: "+15551234567" },
        chatGuid: "iMessage;-;+15551234567",
      },
    });
    expect(result?.fromMe).toBe(true);
  });

  it('treats reaction isFromMe="true" (string) as fromMe', () => {
    const result = normalizeWebhookReaction({
      type: "updated-message",
      data: {
        guid: "msg-2",
        associatedMessageGuid: "p:0/msg-1",
        associatedMessageType: 2000,
        isGroup: false,
        isFromMe: "true",
        handle: { address: "+15551234567" },
        chatGuid: "iMessage;-;+15551234567",
      },
    });
    expect(result?.fromMe).toBe(true);
  });
});

describe("normalizeWebhookReaction", () => {
  it("falls back to DM chatGuid handle when reaction sender handle is missing", () => {
    const result = normalizeWebhookReaction({
      type: "updated-message",
      data: {
        guid: "msg-2",
        associatedMessageGuid: "p:0/msg-1",
        associatedMessageType: 2000,
        isGroup: false,
        isFromMe: false,
        handle: null,
        chatGuid: "iMessage;-;+15551234567",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.messageId).toBe("p:0/msg-1");
    expect(result?.action).toBe("added");
  });
});
