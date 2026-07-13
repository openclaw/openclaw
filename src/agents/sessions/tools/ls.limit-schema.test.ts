import { Check } from "typebox/value";
import { describe, it, expect } from "vitest";
// Test the registered production schema — not a reconstructed copy.
// Importing lsSchema directly ensures the test stays in sync
// with the actual schema used by the ls tool definition.
import { lsSchema } from "./ls.js";

describe("ls tool limit schema", () => {
  it("rejects float limit — matches production Type.Integer behavior", () => {
    expect(Check(lsSchema, { path: ".", limit: 100 })).toBe(true);
    expect(Check(lsSchema, { path: ".", limit: 10.5 })).toBe(false);
  });

  it("accepts default (limit omitted) — matches production Type.Integer behavior", () => {
    expect(Check(lsSchema, { path: "." })).toBe(true);
  });
});
