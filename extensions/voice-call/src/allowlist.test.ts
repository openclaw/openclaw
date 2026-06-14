// Voice Call tests cover allowlist plugin behavior.
import { describe, expect, it } from "vitest";
import { isAllowlistedCaller, isInboundCallAllowed, normalizePhoneNumber } from "./allowlist.js";

describe("voice-call allowlist", () => {
  it("normalizes phone numbers by stripping non-digits", () => {
    expect(normalizePhoneNumber("+1 (415) 555-0123")).toBe("14155550123");
    expect(normalizePhoneNumber("  020-7946-0958  ")).toBe("02079460958");
    expect(normalizePhoneNumber("")).toBe("");
    expect(normalizePhoneNumber()).toBe("");
  });

  it("matches normalized allowlist entries and rejects blank callers", () => {
    expect(isAllowlistedCaller("14155550123", ["+1 (415) 555-0123", " 020-7946-0958 "])).toBe(true);
    expect(isAllowlistedCaller("02079460958", ["+1 (415) 555-0123", " 020-7946-0958 "])).toBe(true);
    expect(isAllowlistedCaller("", ["+1 (415) 555-0123"])).toBe(false);
    expect(isAllowlistedCaller("14155550123", ["", "abc"])).toBe(false);
  });

  it("matches a caller by exact id (e.g. a Teams AAD object id), case-insensitively", () => {
    const aad = "9A783A59-BF32-4D17-8B42-459E8383E8BB";
    expect(isAllowlistedCaller(aad.toLowerCase(), [aad])).toBe(true);
    expect(isAllowlistedCaller(aad, [aad.toLowerCase()])).toBe(true);
    expect(isAllowlistedCaller("00000000-0000-0000-0000-000000000000", [aad])).toBe(false);
  });

  it("isInboundCallAllowed admits an AAD caller under the allowlist policy", () => {
    const aad = "9a783a59-bf32-4d17-8b42-459e8383e8bb";
    expect(isInboundCallAllowed("allowlist", [aad], aad)).toBe(true);
    expect(isInboundCallAllowed("allowlist", [aad], "other-aad-id")).toBe(false);
    expect(isInboundCallAllowed("open", undefined, aad)).toBe(true);
    expect(isInboundCallAllowed("disabled", [aad], aad)).toBe(false);
  });
});
