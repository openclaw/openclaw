// Imessage tests cover normalize plugin behavior.
import { describe, expect, it } from "vitest";
import { looksLikeIMessageTargetId, normalizeIMessageMessagingTarget } from "./normalize.js";

describe("normalizeIMessageMessagingTarget", () => {
  it("normalizes blank inputs to undefined", () => {
    expect(normalizeIMessageMessagingTarget("   ")).toBeUndefined();
  });

  it.each([
    ["sms:+1 (555) 222-3333", "sms:+15552223333"],
    ["sms:++1 (555) 222-3333", "sms:+15552223333"],
    ["Name@Example.com", "name@example.com"],
    ["tel:+1 (555) 222-3333", "+15552223333"],
  ])("normalizes handle %s", (input, expected) => {
    expect(normalizeIMessageMessagingTarget(input)).toBe(expected);
  });

  it.each([
    ["Alice Smith", undefined],
    ["auto:Alice Smith", "auto:AliceSmith"],
    ["sms:auto:Alice Smith", undefined],
    ["auto:chatident:AbC", "chatident:AbC"],
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

  it.each(["7d5297154d5f436d83dbbdf03fcc8fdd", "1".repeat(32)])(
    "treats bare 32-hex %s as a chat identifier before phone normalization",
    (hex) => {
      expect(normalizeIMessageMessagingTarget(hex)).toBe(`chat_identifier:${hex}`);
      expect(normalizeIMessageMessagingTarget(hex.toUpperCase())).toBe(`chat_identifier:${hex}`);
    },
  );
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
