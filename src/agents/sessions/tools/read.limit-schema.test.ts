import { Check } from "typebox/value";
import { describe, it, expect } from "vitest";
// Test the registered production schema — not a reconstructed copy.
import { readSchema } from "./read.js";

describe("read tool limit schema", () => {
  it("rejects float limit — matches production Type.Integer behavior", () => {
    expect(Check(readSchema, { path: "test.ts", limit: 100 })).toBe(true);
    expect(Check(readSchema, { path: "test.ts", limit: 10.5 })).toBe(false);
  });

  it("accepts default (limit omitted) — matches production Type.Integer behavior", () => {
    expect(Check(readSchema, { path: "test.ts" })).toBe(true);
  });
});
