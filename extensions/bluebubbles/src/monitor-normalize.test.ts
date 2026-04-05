import { describe, expect, it } from "vitest";
import { normalizeWebhookMessage, normalizeWebhookReaction } from "./monitor-normalize.js";
import { normalizeChatGuidService } from "./targets.js";

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

  it("normalizes participant handles from the handles field", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-handles-1",
        text: "hello group",
        isGroup: true,
        isFromMe: false,
        handle: { address: "+15550000000" },
        chatGuid: "iMessage;+;chat123456",
        handles: [
          { address: "+15551234567", displayName: "Alice" },
          { address: "+15557654321", displayName: "Bob" },
        ],
      },
    });

    expect(result).not.toBeNull();
    expect(result?.participants).toEqual([
      { id: "+15551234567", name: "Alice" },
      { id: "+15557654321", name: "Bob" },
    ]);
  });

  it("normalizes participant handles from the participantHandles field", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-participant-handles-1",
        text: "hello group",
        isGroup: true,
        isFromMe: false,
        handle: { address: "+15550000000" },
        chatGuid: "iMessage;+;chat123456",
        participantHandles: [{ address: "+15551234567" }, "+15557654321"],
      },
    });

    expect(result).not.toBeNull();
    expect(result?.participants).toEqual([{ id: "+15551234567" }, { id: "+15557654321" }]);
  });

  it("normalizes iMessageLite chatGuid to iMessage (satellite messages)", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-sat-1",
        text: "sent via satellite",
        isGroup: false,
        isFromMe: false,
        handle: { address: "+13178204214" },
        chatGuid: "iMessageLite;-;+13178204214",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.chatGuid).toBe("iMessage;-;+13178204214");
    expect(result?.senderId).toBe("+13178204214");
  });
});

describe("normalizeChatGuidService", () => {
  it("remaps iMessageLite to iMessage", () => {
    expect(normalizeChatGuidService("iMessageLite;-;+13178204214")).toBe(
      "iMessage;-;+13178204214",
    );
  });

  it("remaps iMessageLite case-insensitively", () => {
    expect(normalizeChatGuidService("imessagelite;-;+13178204214")).toBe(
      "iMessage;-;+13178204214",
    );
  });

  it("leaves iMessage unchanged", () => {
    expect(normalizeChatGuidService("iMessage;-;+15551234567")).toBe("iMessage;-;+15551234567");
  });

  it("leaves SMS unchanged", () => {
    expect(normalizeChatGuidService("SMS;-;+15551234567")).toBe("SMS;-;+15551234567");
  });

  it("handles group chat guids", () => {
    expect(normalizeChatGuidService("iMessageLite;+;chat123456")).toBe("iMessage;+;chat123456");
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
});
