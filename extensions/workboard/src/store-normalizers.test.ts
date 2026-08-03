// Regression coverage for the bounded-string normalizer used across Workboard
// input validators. The helper is shared by comment, label, title, url, and
// other bounded fields; an opaque error message blocks agents that overshoot
// the limit because they cannot tell how far over they are.
import { describe, expect, it } from "vitest";
import { normalizeBoundedString } from "./store-normalizers.js";

describe("normalizeBoundedString", () => {
  it("returns the fallback for empty or whitespace input", () => {
    expect(normalizeBoundedString(undefined, "fallback", 10, "field")).toBe("fallback");
    expect(normalizeBoundedString("", "fallback", 10, "field")).toBe("fallback");
    expect(normalizeBoundedString("   ", "fallback", 10, "field")).toBe("fallback");
  });

  it("returns the trimmed value when within the limit", () => {
    expect(normalizeBoundedString("  hello  ", undefined, 10, "field")).toBe("hello");
  });

  it("throws an error that names the actual length when over the limit", () => {
    // Build a body that exceeds the 2000-char comment limit so we exercise the
    // exact path the issue reports (clawsweeper:source-repro).
    const overlong = "x".repeat(3502);
    expect(() => normalizeBoundedString(overlong, undefined, 2000, "comment body")).toThrow(
      /^comment body must be 2000 characters or fewer \(got 3502\)\.$/,
    );
  });

  it("keeps the error message length-aware for every bounded field", () => {
    // title/notes/labels/targetCardId/url/title are bounded through the same
    // helper. A regression that drops the (got N) suffix will fail here.
    const cases: ReadonlyArray<{
      readonly field: string;
      readonly limit: number;
      readonly actual: number;
    }> = [
      { field: "labels", limit: 40, actual: 41 },
      { field: "link title", limit: 180, actual: 181 },
      { field: "title", limit: 180, actual: 9999 },
      { field: "notes", limit: 4000, actual: 4001 },
      { field: "link target", limit: 120, actual: 121 },
      { field: "link URL", limit: 2000, actual: 2001 },
    ];
    for (const c of cases) {
      const overlong = "x".repeat(c.actual);
      expect(() => normalizeBoundedString(overlong, undefined, c.limit, c.field)).toThrow(
        new RegExp(`^${c.field} must be ${c.limit} characters or fewer \\(got ${c.actual}\\)\\.$`),
      );
    }
  });
});
