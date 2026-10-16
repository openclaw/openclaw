import { describe, expect, it } from "vitest";
import { parseIMessageAllowFromEntries } from "./setup-surface.js";
import {
  formatIMessageChatTarget,
  inferIMessageTargetChatType,
  isAllowedIMessageReplyContextSender,
  isAllowedIMessageSender,
  looksLikeIMessageExplicitTargetId,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

describe("imessage targets", () => {
  it("parses sms handles with service", () => {
    const target = parseIMessageTarget("sms:+1555");
    expect(target).toEqual({
      kind: "handle",
      to: "+1555",
      service: "sms",
      serviceExplicit: true,
    });
  });

  it("normalizes service-prefixed chat identifiers", () => {
    expect(normalizeIMessageHandle("auto:chatident:AbC")).toBe("chat_identifier:AbC");
  });

  it("does not check allowFrom against conversation targets", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["chat_id:9"],
      sender: "+1555",
      chatId: 9,
    });
    expect(ok).toBe(false);

    expect(
      isAllowedIMessageSender({
        allowFrom: ["imessage:chat_id:9"],
        sender: "+1555",
        chatId: 9,
      }),
    ).toBe(false);

    expect(
      isAllowedIMessageSender({
        allowFrom: ["chat_guid:team-thread"],
        sender: "+1555",
        chatGuid: "team-thread",
      }),
    ).toBe(false);

    expect(
      isAllowedIMessageSender({
        allowFrom: ["chat_identifier:team"],
        sender: "+1555",
        chatIdentifier: "team",
      }),
    ).toBe(false);

    expect(
      isAllowedIMessageSender({
        allowFrom: ["chat_id:9"],
        sender: "+1555",
        chatId: 9,
        allowConversationTargets: true,
      }),
    ).toBe(false);
  });

  it("checks allowFrom against handle", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["user@example.com"],
      sender: "User@Example.com",
    });
    expect(ok).toBe(true);
  });

  it("checks reply context allowFrom against conversation targets", () => {
    expect(
      isAllowedIMessageReplyContextSender({
        allowFrom: ["chat_id:9"],
        sender: "+1555",
        chatId: 9,
      }),
    ).toBe(true);

    expect(
      isAllowedIMessageReplyContextSender({
        allowFrom: ["imessage:chat_guid:team-thread"],
        sender: "+1555",
        chatGuid: "team-thread",
      }),
    ).toBe(true);

    expect(
      isAllowedIMessageReplyContextSender({
        allowFrom: ["chat_identifier:team"],
        sender: "+1555",
        chatIdentifier: "team",
      }),
    ).toBe(true);
  });

  it("denies when allowFrom is empty", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: [],
      sender: "+1555",
    });
    expect(ok).toBe(false);
  });

  it("formats chat targets", () => {
    expect(formatIMessageChatTarget(42)).toBe("chat_id:42");
    expect(formatIMessageChatTarget(undefined)).toBe("");
  });

  it("only treats explicit chat targets as immediate ids", () => {
    expect(looksLikeIMessageExplicitTargetId("chat_id:42")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("sms:+15552223333")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("+15552223333")).toBe(false);
    expect(looksLikeIMessageExplicitTargetId("user@example.com")).toBe(false);
    expect(looksLikeIMessageExplicitTargetId("7d5297154d5f436d83dbbdf03fcc8fdd")).toBe(true);
  });

  it("infers direct and group chat types from normalized targets", () => {
    expect(inferIMessageTargetChatType("+15552223333")).toBe("direct");
    expect(inferIMessageTargetChatType("chat_id:42")).toBeUndefined();
    expect(inferIMessageTargetChatType("chat_guid:iMessage;-;+15552223333")).toBe("direct");
    expect(inferIMessageTargetChatType("chat_guid:iMessage;+;chat42")).toBe("group");
  });

  it("treats bare 32-char hex strings as chat identifiers, not phone numbers", () => {
    const hex = "7d5297154d5f436d83dbbdf03fcc8fdd";
    expect(normalizeIMessageHandle(hex)).toBe(`chat_identifier:${hex}`);
    expect(normalizeIMessageHandle(hex.toUpperCase())).toBe(`chat_identifier:${hex}`);
    expect(parseIMessageTarget(hex)).toEqual({
      kind: "chat_identifier",
      chatIdentifier: hex,
    });
    expect(parseIMessageTarget(`imessage:${hex.toUpperCase()}`)).toEqual({
      kind: "chat_identifier",
      chatIdentifier: hex,
    });
    expect(inferIMessageTargetChatType(hex)).toBeUndefined();
  });
});

describe("parseIMessageAllowFromEntries", () => {
  it("parses handles", () => {
    expect(parseIMessageAllowFromEntries("+15555550123, user@example.com")).toEqual({
      entries: ["+15555550123", "user@example.com"],
    });
  });

  it("returns validation errors for chat target entries", () => {
    expect(parseIMessageAllowFromEntries("chat_id:123")).toEqual({
      entries: [],
      error: "iMessage allowFrom entries must be sender handles: chat_id:123",
    });

    expect(parseIMessageAllowFromEntries("imessage:chat_id:123")).toEqual({
      entries: [],
      error: "iMessage allowFrom entries must be sender handles: imessage:chat_id:123",
    });
  });
});
