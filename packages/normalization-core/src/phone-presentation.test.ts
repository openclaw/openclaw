import { describe, expect, it } from "vitest";
import { formatInternationalPhoneNumberForDisplay } from "./phone-presentation.js";

describe("formatInternationalPhoneNumberForDisplay", () => {
  it.each([
    ["  +4930123456  ", "Germany · +49 30 123456"],
    ["+15551234567", "+1 555 123 4567"],
  ])("formats %s for display without requiring assignment validity", (raw, expected) => {
    expect(formatInternationalPhoneNumberForDisplay(raw, "en")).toBe(expected);
  });

  it.each([
    ["NANPA US", "+12133734253", "+1 213 373 4253"],
    ["United Kingdom", "+442079460018", "+44 20 7946 0018"],
  ])("does not claim a country for shared calling codes: %s", (_name, raw, expected) => {
    expect(formatInternationalPhoneNumberForDisplay(raw, "en")).toBe(expected);
  });

  it("formats non-geographic numbers without a country label", () => {
    expect(formatInternationalPhoneNumberForDisplay("+80012345678", "en")).toBe("+800 1234 5678");
  });

  it.each([
    ["malformed", "+not-a-number"],
    ["short", "+123"],
    ["national", "020 7946 0018"],
  ])("returns undefined for %s input", (_kind, raw) => {
    expect(formatInternationalPhoneNumberForDisplay(raw, "en")).toBeUndefined();
  });

  it("returns undefined for a malformed locale", () => {
    expect(formatInternationalPhoneNumberForDisplay("+4930123456", "not_a_locale")).toBeUndefined();
  });
});
