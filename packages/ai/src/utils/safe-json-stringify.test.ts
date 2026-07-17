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
    expect(safeJsonStringify(circular)).toBe("[object Object]");
  });

  it("does not throw on a non-Error network error carrying circular socket refs", () => {
    const socket: Record<string, unknown> = {};
    const err: Record<string, unknown> = { code: "ECONNRESET", socket };
    socket.parent = err; // circular
    expect(() => JSON.stringify(err)).toThrow(TypeError);
    expect(safeJsonStringify(err)).toBe("[object Object]");
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

  it("does not throw when String() itself would throw (null-prototype object)", () => {
    // Object.create(null) has no toString/valueOf; String() throws TypeError.
    const bare = Object.create(null);
    bare.circular = bare;
    expect(() => JSON.stringify(bare)).toThrow(TypeError);
    // First JSON.stringify fails, then String() also fails → sentinel.
    expect(safeJsonStringify(bare)).toBe("<unserializable error>");
  });

  it("does not throw on a circular object whose Symbol.toPrimitive also throws", () => {
    // Circular so JSON.stringify throws; then String() also throws because
    // Symbol.toPrimitive is invoked during primitive conversion.
    const hostile: Record<string, unknown> = {
      [Symbol.toPrimitive](): string {
        throw new TypeError("toPrimitive boom");
      },
    };
    hostile.self = hostile;
    expect(() => JSON.stringify(hostile)).toThrow(TypeError);
    expect(() => String(hostile)).toThrow(TypeError);
    expect(safeJsonStringify(hostile)).toBe("<unserializable error>");
  });

  it("does not throw when JSON.stringify-undefined value's toString throws", () => {
    // JSON.stringify returns undefined for functions. If the function's custom
    // toString throws, the String(…) fallback itself must be guarded.
    const fn = Object.defineProperty(() => {}, "toString", {
      value() {
        throw new TypeError("toString boom");
      },
    });
    expect(JSON.stringify(fn)).toBeUndefined();
    expect(() => String(fn)).toThrow(TypeError);
    expect(safeJsonStringify(fn)).toBe("<unserializable error>");
  });
});
