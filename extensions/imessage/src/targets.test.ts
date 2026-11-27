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
  it("normalizes service-prefixed chat identifiers", () => {
    expect(normalizeIMessageHandle("auto:chatident:AbC")).toBe("chat_identifier:AbC");
  });

  it.each([
    ["chat_id:9", { chatId: 9 }],
    ["imessage:chat_id:9", { chatId: 9 }],
    ["imessage:chat_guid:team-thread", { chatGuid: "team-thread" }],
    ["chat_identifier:team", { chatIdentifier: "team" }],
  ] as const)("only permits conversation allowFrom %s for reply context", (entry, context) => {
    const params = {
      sender: "+1555",
      ...context,
      allowFrom: [entry],
      allowConversationTargets: true,
    };
    expect(isAllowedIMessageSender(params)).toBe(false);
    expect(isAllowedIMessageReplyContextSender(params)).toBe(true);
  });

  it.each([
    [["user@example.com"], "User@Example.com", true],
    [[], "+1555", false],
  ] as const)("checks sender %s / %s", (allowFrom, sender, allowed) => {
    expect(isAllowedIMessageSender({ allowFrom: [...allowFrom], sender })).toBe(allowed);
  });

  it("formats chat targets", () => {
    expect(formatIMessageChatTarget(42)).toBe("chat_id:42");
    expect(formatIMessageChatTarget(undefined)).toBe("");
  });

  it("only treats explicit chat targets as immediate ids", () => {
    expect(looksLikeIMessageExplicitTargetId("chat_id:42")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("sms:+15552223333")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("+15552223333")).toBe(false);
    expect(looksLikeIMessageExplicitTargetId("7d5297154d5f436d83dbbdf03fcc8fdd")).toBe(true);
  });

  it("treats bare 32-char hex strings as chat identifiers, not phone numbers", () => {
    const hex = "7d5297154d5f436d83dbbdf03fcc8fdd";
    expect(normalizeIMessageHandle(hex)).toBe(`chat_identifier:${hex}`);
    expect(normalizeIMessageHandle(hex.toUpperCase())).toBe(`chat_identifier:${hex}`);
    const parsed = { kind: "chat_identifier", chatIdentifier: hex };
    expect([hex, `imessage:${hex.toUpperCase()}`].map(parseIMessageTarget)).toEqual([
      parsed,
      parsed,
    ]);
    expect(inferIMessageTargetChatType(hex)).toBeUndefined();
    expect(inferIMessageTargetChatType("chat_id:42")).toBeUndefined();
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
