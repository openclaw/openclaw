import { describe, expect, it } from "vitest";
import { looksLikeIMessageTargetId, normalizeIMessageMessagingTarget } from "./normalize.js";

describe("normalizeIMessageMessagingTarget", () => {
  it("normalizes blank inputs to undefined", () => {
    expect(normalizeIMessageMessagingTarget("   ")).toBeUndefined();
  });

  it.each([
    ["sms:auto:Alice Smith", undefined],
    ["auto:C0AG22RN7L3", "auto:C0AG22RN7L3"],
  ] as const)("preserves the service and contact boundary for %s", (input, expected) => {
    expect(normalizeIMessageMessagingTarget(input)).toBe(expected);
  });

  it("rejects unqualified provider identifiers instead of coercing them into phone numbers", () => {
    expect(normalizeIMessageMessagingTarget("C0AG22RN7L3")).toBeUndefined();
  });

  it("drops service prefixes for chat targets", () => {
    expect(normalizeIMessageMessagingTarget("sms:chat_id:123")).toBe("chat_id:123");
    expect(normalizeIMessageMessagingTarget("imessage:CHAT_GUID:abc")).toBe("chat_guid:abc");
    expect(normalizeIMessageMessagingTarget("auto:ChatIdentifier:foo")).toBe("chatidentifier:foo");
  });
});

describe("looksLikeIMessageTargetId", () => {
  it("detects common iMessage target forms", () => {
    expect(looksLikeIMessageTargetId("sms:+15555550123")).toBe(true);
    expect(looksLikeIMessageTargetId("chat_id:123")).toBe(true);
    expect(looksLikeIMessageTargetId("user@example.com")).toBe(true);
    expect(looksLikeIMessageTargetId("+15555550123")).toBe(true);
    expect(looksLikeIMessageTargetId("")).toBe(false);
    expect(looksLikeIMessageTargetId("7d5297154d5f436d83dbbdf03fcc8fdd")).toBe(true);
  });
});
