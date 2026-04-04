import { describe, expect, it } from "vitest";
import { stableStringify } from "./stable-stringify.js";

describe("stableStringify", () => {
  it("stringifies primitives", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify("hello")).toBe('"hello"');
  });

  it("stringifies arrays in order", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(stableStringify(["b", "a"])).toBe('["b","a"]');
  });

  it("sorts object keys", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ z: 1, y: 2, x: 3 })).toBe('{"x":3,"y":2,"z":1}');
  });

  it("handles nested structures", () => {
    const nested = { c: [3, 2, 1], b: { y: "b", x: "a" }, a: 1 };
    const result = stableStringify(nested);
    expect(result).toContain('"a":1');
    expect(result).toContain('"b":');
    expect(result).toContain('"c":');
  });

  it("escapes keys properly", () => {
    expect(stableStringify({ "a/b": 1 })).toBe('{"a/b":1}');
    expect(stableStringify({ "a:b": 1 })).toBe('{"a:b":1}');
  });

  it("produces consistent output for same input", () => {
    const obj = { z: 3, a: 1, m: 2 };
    expect(stableStringify(obj)).toBe(stableStringify(obj));
  });
});
