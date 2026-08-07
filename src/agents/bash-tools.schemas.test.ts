import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { processSchema } from "./bash-tools.schemas.js";

const base = { action: "log" };

describe("processSchema offset/limit", () => {
  // Baseline: valid integer values
  it("accepts valid integer offset and limit", () => {
    expect(Value.Check(processSchema, { ...base, offset: 0, limit: 50 })).toBe(true);
    expect(Value.Check(processSchema, { ...base, offset: 10, limit: 1 })).toBe(true);
    expect(Value.Check(processSchema, { ...base, offset: 100 })).toBe(true);
  });

  // The tightened contract: floats are rejected (Type.Integer, not Type.Number)
  it("rejects fractional offset and limit", () => {
    expect(Value.Check(processSchema, { ...base, offset: 1.5, limit: 10 })).toBe(false);
    expect(Value.Check(processSchema, { ...base, offset: 0, limit: 10.5 })).toBe(false);
  });

  // The preserved behavior: negative values pass schema and are normalized at runtime
  it("preserves negative-value normalization — passes schema", () => {
    expect(Value.Check(processSchema, { ...base, offset: -1, limit: 50 })).toBe(true);
    expect(Value.Check(processSchema, { ...base, offset: -10 })).toBe(true);
  });

  // Optional fields
  it("accepts omitted optional fields", () => {
    expect(Value.Check(processSchema, base)).toBe(true);
    expect(Value.Check(processSchema, { ...base, offset: 0 })).toBe(true);
    expect(Value.Check(processSchema, { ...base, limit: 50 })).toBe(true);
  });
});
