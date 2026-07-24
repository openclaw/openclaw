import { Check } from "typebox/value";
import { describe, it, expect } from "vitest";
import { grepSchema } from "./grep.js";

describe("grep tool context/limit schema", () => {
  it("rejects float context and limit — validates against production grepSchema", () => {
    expect(Check(grepSchema, { pattern: "foo", context: 3, limit: 50 })).toBe(true);
    expect(Check(grepSchema, { pattern: "foo", context: 1.5, limit: 50 })).toBe(false);
    expect(Check(grepSchema, { pattern: "foo", context: 3, limit: 10.5 })).toBe(false);
    expect(Check(grepSchema, { pattern: "foo" })).toBe(true);
  });
});
