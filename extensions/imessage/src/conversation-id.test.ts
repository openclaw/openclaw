// Imessage conversation-id tests cover group anchor resolution and inbound id derivation.
import { describe, expect, it } from "vitest";
import {
  resolveIMessageGroupAnchorId,
  resolveIMessageInboundConversationId,
} from "./conversation-id.js";

describe("resolveIMessageGroupAnchorId", () => {
  it("prefers a positive chat_id over chat_guid / chat_identifier", () => {
    expect(
      resolveIMessageGroupAnchorId({
        chatId: 349,
        chatGuid: "iMessage;+;chat349",
        chatIdentifier: "chat349",
      }),
    ).toBe("349");
  });

  it("falls back to chat_guid when chat_id is missing or non-positive", () => {
    expect(
      resolveIMessageGroupAnchorId({
        chatId: 0,
        chatGuid: "iMessage;+;chat349",
        chatIdentifier: "chat349",
      }),
    ).toBe("iMessage;+;chat349");
    expect(
      resolveIMessageGroupAnchorId({
        chatId: -1,
        chatGuid: "iMessage;+;chat349",
        chatIdentifier: "chat349",
      }),
    ).toBe("iMessage;+;chat349");
    expect(
      resolveIMessageGroupAnchorId({
        chatId: undefined,
        chatGuid: "iMessage;+;chat349",
        chatIdentifier: "chat349",
      }),
    ).toBe("iMessage;+;chat349");
    expect(
      resolveIMessageGroupAnchorId({
        chatId: null,
        chatGuid: "iMessage;+;chat349",
      }),
    ).toBe("iMessage;+;chat349");
  });

  it("falls back to chat_identifier when chat_id and chat_guid are unusable", () => {
    expect(
      resolveIMessageGroupAnchorId({
        chatId: 0,
        chatGuid: "",
        chatIdentifier: "chat349",
      }),
    ).toBe("chat349");
    expect(
      resolveIMessageGroupAnchorId({
        chatId: undefined,
        chatGuid: "   ",
        chatIdentifier: "chat349",
      }),
    ).toBe("chat349");
  });

  it("returns undefined when no anchor is usable", () => {
    expect(
      resolveIMessageGroupAnchorId({
        chatId: 0,
        chatGuid: "",
        chatIdentifier: "",
      }),
    ).toBeUndefined();
    expect(
      resolveIMessageGroupAnchorId({
        chatId: undefined,
        chatGuid: undefined,
        chatIdentifier: undefined,
      }),
    ).toBeUndefined();
  });

  it("ignores non-finite chat_id values", () => {
    expect(
      resolveIMessageGroupAnchorId({
        chatId: Number.NaN,
        chatGuid: "iMessage;+;chat349",
      }),
    ).toBe("iMessage;+;chat349");
  });
});

describe("resolveIMessageInboundConversationId", () => {
  it("uses the group anchor id for group messages", () => {
    expect(
      resolveIMessageInboundConversationId({
        isGroup: true,
        sender: "+15555550123",
        chatId: 349,
        chatGuid: "iMessage;+;chat349",
        chatIdentifier: "chat349",
      }),
    ).toBe("349");
  });

  it("falls back to chat_guid for groups without a positive chat_id", () => {
    expect(
      resolveIMessageInboundConversationId({
        isGroup: true,
        sender: "+15555550123",
        chatId: 0,
        chatGuid: "iMessage;+;chat349",
        chatIdentifier: "chat349",
      }),
    ).toBe("iMessage;+;chat349");
  });

  it("returns undefined for groups with no usable anchor", () => {
    expect(
      resolveIMessageInboundConversationId({
        isGroup: true,
        sender: "+15555550123",
        chatId: 0,
        chatGuid: "",
        chatIdentifier: "",
      }),
    ).toBeUndefined();
  });

  it("uses the normalized sender for direct messages", () => {
    expect(
      resolveIMessageInboundConversationId({
        isGroup: false,
        sender: "+15555550123",
        chatId: 42,
      }),
    ).toBe("+15555550123");
  });
});
