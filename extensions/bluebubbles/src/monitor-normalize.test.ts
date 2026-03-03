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

  it("promotes group-hint metadata to group chat context", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello group",
        handle: { address: "+15551234567" },
        is_group_chat: "true",
        conversation_label: "Group id:any;+;7a77739c144e46798b4747b98ebe63a4",
        isFromMe: false,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.isGroup).toBe(true);
    expect(result?.chatGuid).toBe("any;+;7a77739c144e46798b4747b98ebe63a4");
    expect(result?.chatIdentifier).toBe("7a77739c144e46798b4747b98ebe63a4");
    expect(result?.explicitIsGroupHint).toBe(true);
  });

  it("does not force group routing from string group hints without chat identity", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        handle: { address: "+15551234567" },
        is_group_chat: "true",
        isFromMe: false,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.isGroup).toBe(false);
    expect(result?.explicitIsGroupHint).toBeUndefined();
    expect(result?.chatGuid).toBeUndefined();
    expect(result?.chatIdentifier).toBeUndefined();
    expect(result?.chatId).toBeUndefined();
  });

  it("does not force group routing from numeric group hints without chat identity", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        handle: { address: "+15551234567" },
        is_group_chat: 1,
        isFromMe: false,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.isGroup).toBe(false);
    expect(result?.explicitIsGroupHint).toBeUndefined();
    expect(result?.chatGuid).toBeUndefined();
    expect(result?.chatIdentifier).toBeUndefined();
    expect(result?.chatId).toBeUndefined();
  });

  it("does not force group routing from boolean group hints without chat identity", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        handle: { address: "+15551234567" },
        is_group_chat: true,
        isFromMe: false,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.isGroup).toBe(false);
    expect(result?.explicitIsGroupHint).toBeUndefined();
    expect(result?.chatGuid).toBeUndefined();
    expect(result?.chatIdentifier).toBeUndefined();
    expect(result?.chatId).toBeUndefined();
  });

  it("treats legacy group flag as explicit group metadata", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-legacy-group-flag",
        text: "hello",
        handle: { address: "+15551234567" },
        conversation_label: "Group id:Unknown",
        group: true,
        isFromMe: false,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.isGroup).toBe(false);
    expect(result?.explicitGroupChatHint).toBe(true);
    expect(result?.hasExplicitGroupChatFlag).toBe(true);
    expect(result?.chatGuid).toBeUndefined();
    expect(result?.chatIdentifier).toBeUndefined();
    expect(result?.chatId).toBeUndefined();
  });

  it("does not treat DM conversation labels as group chat GUIDs", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello",
        handle: { address: "+15551234567" },
        conversation_label: "Alice id:+15551234567",
        is_group_chat: false,
        isFromMe: false,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.isGroup).toBe(false);
    expect(result?.chatGuid).toBeUndefined();
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
