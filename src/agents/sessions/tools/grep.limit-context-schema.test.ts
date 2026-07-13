import { Check } from "typebox/value";
import { describe, it, expect } from "vitest";
// Test the registered production schema — not a reconstructed copy.
import { grepSchema } from "./grep.js";

describe("grep tool limit and context schema", () => {
  it("rejects float limit — matches production Type.Integer behavior", () => {
    expect(Check(grepSchema, { pattern: "test", limit: 100 })).toBe(true);
    expect(Check(grepSchema, { pattern: "test", limit: 10.5 })).toBe(false);
  });

  it("rejects float context — matches production Type.Integer behavior", () => {
    expect(Check(grepSchema, { pattern: "test", context: 5 })).toBe(true);
    expect(Check(grepSchema, { pattern: "test", context: 2.5 })).toBe(false);
  });

  it("accepts defaults (limit and context omitted)", () => {
    expect(Check(grepSchema, { pattern: "test" })).toBe(true);
  });
});
