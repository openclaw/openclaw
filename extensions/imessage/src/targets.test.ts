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
    expect(parseIMessageTarget("sms:+1555")).toEqual({
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
    for (const [entry, context] of [
      ["chat_id:9", { chatId: 9 }],
      ["imessage:chat_id:9", { chatId: 9 }],
      ["chat_guid:team-thread", { chatGuid: "team-thread" }],
      ["chat_identifier:team", { chatIdentifier: "team" }],
    ] as const) {
      expect(isAllowedIMessageSender({ sender: "+1555", ...context, allowFrom: [entry] })).toBe(
        false,
      );
    }
    expect(
      isAllowedIMessageSender({
        sender: "+1555",
        chatId: 9,
        allowFrom: ["chat_id:9"],
        allowConversationTargets: true,
      }),
    ).toBe(false);
  });

  it("checks allowFrom against handle", () => {
    expect(
      isAllowedIMessageSender({
        allowFrom: ["user@example.com"],
        sender: "User@Example.com",
      }),
    ).toBe(true);
  });

  it("checks reply context allowFrom against conversation targets", () => {
    for (const [entry, context] of [
      ["chat_id:9", { chatId: 9 }],
      ["imessage:chat_guid:team-thread", { chatGuid: "team-thread" }],
      ["chat_identifier:team", { chatIdentifier: "team" }],
    ] as const) {
      expect(
        isAllowedIMessageReplyContextSender({ sender: "+1555", ...context, allowFrom: [entry] }),
      ).toBe(true);
    }
  });

  it("denies when allowFrom is empty", () => {
    expect(isAllowedIMessageSender({ allowFrom: [], sender: "+1555" })).toBe(false);
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

  it.each(["chat_id:123", "imessage:chat_id:123"])("rejects chat target entry %s", (entry) => {
    expect(parseIMessageAllowFromEntries(entry)).toEqual({
      entries: [],
      error: `iMessage allowFrom entries must be sender handles: ${entry}`,
    });
  });
});
