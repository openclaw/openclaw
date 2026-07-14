import { describe, expect, it } from "vitest";
import { safeJsonStringify } from "./safe-json-stringify.js";

describe("safeJsonStringify", () => {
  it("serializes plain objects the same as JSON.stringify", () => {
    expect(safeJsonStringify({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(safeJsonStringify([1, 2, 3])).toBe("[1,2,3]");
  });

  it("serializes primitives", () => {
    expect(safeJsonStringify("hello")).toBe('"hello"');
    expect(safeJsonStringify(42)).toBe("42");
    expect(safeJsonStringify(true)).toBe("true");
    expect(safeJsonStringify(null)).toBe("null");
  });

  it("does not throw on circular structures and falls back to String (#106570)", () => {
    const circular: Record<string, unknown> = { name: "socket" };
    circular.self = circular;
    // JSON.stringify would throw "Converting circular structure to JSON" here.
    expect(() => JSON.stringify(circular)).toThrow(TypeError);
    expect(safeJsonStringify(circular)).toBe(String(circular));
    expect(safeJsonStringify(circular)).toBe("[object Object]");
  });

  it("does not throw on a non-Error network error carrying circular socket refs", () => {
    const socket: Record<string, unknown> = {};
    const err: Record<string, unknown> = { code: "ECONNRESET", socket };
    socket.parent = err; // circular
    expect(() => JSON.stringify(err)).toThrow(TypeError);
    expect(safeJsonStringify(err)).toBe(String(err));
  });

  it("falls back to String for values JSON.stringify drops to undefined", () => {
    expect(safeJsonStringify(undefined)).toBe("undefined");
    const fn = () => 1;
    expect(safeJsonStringify(fn)).toBe(String(fn));
  });

  it("does not throw on BigInt", () => {
    expect(() => JSON.stringify(10n)).toThrow(TypeError);
    expect(safeJsonStringify(10n)).toBe("10");
  });
});
