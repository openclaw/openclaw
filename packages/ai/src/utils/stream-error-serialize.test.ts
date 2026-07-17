import { describe, it, expect } from "vitest";
import { serializeStreamError } from "./stream-error-serialize.js";

function makeCircular() {
  const e: Record<string, unknown> = { code: "ECONNRESET", message: "socket hang up" };
  e.self = e;
  return e;
}

describe("serializeStreamError", () => {
  it("returns Error.message for Error instances", () => {
    expect(serializeStreamError(new Error("boom"))).toBe("boom");
  });

  it("returns JSON for serializable plain objects", () => {
    expect(serializeStreamError({ code: 400, reason: "bad" })).toBe('{"code":400,"reason":"bad"}');
  });

  it("falls back to String() for circular references (no throw)", () => {
    const circular = makeCircular();
    const result = serializeStreamError(circular);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe("[object Object]");
  });

  it("falls back to String() for non-serializable values", () => {
    const sym = Symbol("test");
    const result = serializeStreamError(sym);
    expect(result).toBe("Symbol(test)");
  });
});