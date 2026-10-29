// Browser tests cover the system-profile import domain-filter parser.
import { describe, expect, it } from "vitest";
import { parseSystemProfileDomains } from "./system-profile-domains.js";

describe("parseSystemProfileDomains", () => {
  it("returns undefined for an absent filter", () => {
    expect(parseSystemProfileDomains(undefined)).toBeUndefined();
    expect(parseSystemProfileDomains(null)).toBeUndefined();
  });

  it("normalizes a valid array (trims, drops blanks)", () => {
    expect(parseSystemProfileDomains(["google.com", " youtube.com ", "", "  "])).toEqual([
      "google.com",
      "youtube.com",
    ]);
  });

  it("fails closed when filtering non-string entries leaves no domains", () => {
    expect(() => parseSystemProfileDomains([1, true])).toThrow(
      "domains must include at least one non-empty domain",
    );
  });
});
