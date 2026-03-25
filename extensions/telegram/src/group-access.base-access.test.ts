import { describe, expect, it } from "vitest";
import { normalizeAllowFrom, type NormalizedAllowFrom } from "./bot-access.js";
import { evaluateTelegramGroupBaseAccess } from "./group-access.js";

function allow(entries: string[], hasWildcard = false): NormalizedAllowFrom {
  return {
    entries,
    hasWildcard,
    hasEntries: entries.length > 0 || hasWildcard,
    invalidEntries: [],
  };
}

describe("evaluateTelegramGroupBaseAccess", () => {
  it("normalizes sender-only allowlist entries and rejects group ids", () => {
    const result = normalizeAllowFrom(["-1001234567890", " tg:-100999 ", "745123456", "@someone"]);

    expect(result).toEqual({
      entries: ["745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["-1001234567890", "-100999", "@someone"],
    });
  });

  it("fails closed when explicit group allowFrom override is empty", () => {
    const result = evaluateTelegramGroupBaseAccess({
      isGroup: true,
      hasGroupAllowOverride: true,
      effectiveGroupAllow: allow([]),
      senderId: "12345",
      senderUsername: "tester",
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });

    expect(result).toEqual({ allowed: false, reason: "group-override-unauthorized" });
  });

  it("allows group message when override is not configured", () => {
    const result = evaluateTelegramGroupBaseAccess({
      isGroup: true,
      hasGroupAllowOverride: false,
      effectiveGroupAllow: allow([]),
      senderId: "12345",
      senderUsername: "tester",
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });

    expect(result).toEqual({ allowed: true });
  });

  it("allows sender explicitly listed in override", () => {
    const result = evaluateTelegramGroupBaseAccess({
      isGroup: true,
      hasGroupAllowOverride: true,
      effectiveGroupAllow: allow(["12345"]),
      senderId: "12345",
      senderUsername: "tester",
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });

    expect(result).toEqual({ allowed: true });
  });
});
