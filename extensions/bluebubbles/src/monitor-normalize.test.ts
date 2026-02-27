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

  it("coerces isFromMe string 'true' to boolean true (#25056)", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-from-me-str",
        text: "echo me",
        handle: { address: "+15551234567" },
        isGroup: false,
        isFromMe: "true",
      },
    });
    expect(result).not.toBeNull();
    expect(result?.fromMe).toBe(true);
  });

  it("coerces isFromMe string 'false' to boolean false (#25056)", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-not-me-str",
        text: "hello",
        handle: { address: "+15551234567" },
        isGroup: false,
        isFromMe: "false",
      },
    });
    expect(result).not.toBeNull();
    expect(result?.fromMe).toBe(false);
  });

  it("coerces isFromMe number 1 to boolean true (#25056)", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-from-me-num",
        text: "echo me",
        handle: { address: "+15551234567" },
        isGroup: false,
        isFromMe: 1,
      },
    });
    expect(result).not.toBeNull();
    expect(result?.fromMe).toBe(true);
  });

  it("coerces isFromMe number 0 to boolean false (#25056)", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-not-me-num",
        text: "hello",
        handle: { address: "+15551234567" },
        isGroup: false,
        isFromMe: 0,
      },
    });
    expect(result).not.toBeNull();
    expect(result?.fromMe).toBe(false);
  });

  it("coerces is_from_me snake_case string 'true' to boolean true (#25056)", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-snake-str",
        text: "echo me",
        handle: { address: "+15551234567" },
        isGroup: false,
        is_from_me: "true",
      },
    });
    expect(result).not.toBeNull();
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

  it("coerces isFromMe string 'true' to boolean true in reactions (#25056)", () => {
    const result = normalizeWebhookReaction({
      type: "updated-message",
      data: {
        guid: "msg-react-str",
        associatedMessageGuid: "p:0/msg-1",
        associatedMessageType: 2000,
        isGroup: false,
        isFromMe: "true",
        handle: { address: "+15551234567" },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.fromMe).toBe(true);
  });

  it("coerces isFromMe number 1 to boolean true in reactions (#25056)", () => {
    const result = normalizeWebhookReaction({
      type: "updated-message",
      data: {
        guid: "msg-react-num",
        associatedMessageGuid: "p:0/msg-1",
        associatedMessageType: 2000,
        isGroup: false,
        isFromMe: 1,
        handle: { address: "+15551234567" },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.fromMe).toBe(true);
  });
});
