// OC Path tests cover slug plugin behavior.
import { describe, expect, it } from "vitest";
import { slugify } from "../slug.js";

describe("slugify", () => {
  it("replaces underscores with hyphens", () => {
    expect(slugify("API_KEY")).toBe("api-key");
  });

  it("trims surrounding whitespace + non-slug chars", () => {
    expect(slugify("  Restricted Data  ")).toBe("restricted-data");
  });

  it("handles colon + space patterns", () => {
    expect(slugify("deny: secrets")).toBe("deny-secrets");
  });

  it("collapses repeated hyphens", () => {
    expect(slugify("foo----bar")).toBe("foo-bar");
  });

  it("returns empty for non-slug-valid input", () => {
    expect(slugify("!!")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  it("handles unicode by stripping (current ASCII-only policy)", () => {
    // Caveat: unicode in headings becomes empty/lossy. Document as a
    // known limit; lint rules can flag non-ASCII headings if needed.
    expect(slugify("Café")).toBe("caf");
  });
});
