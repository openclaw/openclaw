import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { execSchema } from "./bash-tools.schemas.js";

describe("execSchema yieldMs (production)", () => {
  it("accepts valid positive integer yieldMs", () => {
    const result = Value.Check(execSchema, {
      command: "echo hi",
      yieldMs: 10000,
    });
    expect(result).toBe(true);
  });

  it("accepts yieldMs=0 (minimum boundary)", () => {
    const result = Value.Check(execSchema, {
      command: "echo hi",
      yieldMs: 0,
    });
    expect(result).toBe(true);
  });

  it("rejects float yieldMs", () => {
    const result = Value.Check(execSchema, {
      command: "echo hi",
      yieldMs: 10.5,
    });
    expect(result).toBe(false);
  });

  it("rejects negative yieldMs (below minimum 0)", () => {
    const result = Value.Check(execSchema, {
      command: "echo hi",
      yieldMs: -100,
    });
    expect(result).toBe(false);
  });

  it("accepts omitted yieldMs (optional)", () => {
    const result = Value.Check(execSchema, { command: "echo hi" });
    expect(result).toBe(true);
  });

  it("accepts yieldMs with background flag", () => {
    const result = Value.Check(execSchema, {
      command: "long-task",
      yieldMs: 5000,
      background: true,
    });
    expect(result).toBe(true);
  });

  it("still validates required command", () => {
    const result = Value.Check(execSchema, { yieldMs: 5000 });
    expect(result).toBe(false);
  });

  it("rejects invalid command type with valid yieldMs", () => {
    const result = Value.Check(execSchema, {
      command: 123,
      yieldMs: 5000,
    });
    expect(result).toBe(false);
  });
});
