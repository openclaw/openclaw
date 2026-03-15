import { describe, expect, it } from "vitest";
import { readString, readBool, readNumber } from "./meta.js";

describe("readString", () => {
  it("returns the first non-empty string value", () => {
    const meta = { a: "", b: "  ", c: "value", d: "other" };
    expect(readString(meta, ["a", "b", "c", "d"])).toBe("value");
  });

  it("returns undefined when no keys match", () => {
    const meta = { a: "", b: "  ", c: null };
    expect(readString(meta, ["a", "b", "c", "d"])).toBeUndefined();
  });

  it("returns undefined for null/undefined meta", () => {
    expect(readString(null, ["a"])).toBeUndefined();
    expect(readString(undefined, ["a"])).toBeUndefined();
  });

  it("trims whitespace from values", () => {
    const meta = { a: "  trimmed  " };
    expect(readString(meta, ["a"])).toBe("trimmed");
  });

  it("skips non-string values", () => {
    const meta = { a: 123, b: true, c: "string" };
    expect(readString(meta, ["a", "b", "c"])).toBe("string");
  });
});

describe("readBool", () => {
  it("returns the first boolean value", () => {
    const meta = { a: "string", b: true, c: false };
    expect(readBool(meta, ["a", "b", "c"])).toBe(true);
  });

  it("returns undefined when no boolean found", () => {
    const meta = { a: "true", b: 1, c: null };
    expect(readBool(meta, ["a", "b", "c"])).toBeUndefined();
  });

  it("returns false when explicitly set to false", () => {
    const meta = { a: false };
    expect(readBool(meta, ["a"])).toBe(false);
  });

  it("returns undefined for null/undefined meta", () => {
    expect(readBool(null, ["a"])).toBeUndefined();
    expect(readBool(undefined, ["a"])).toBeUndefined();
  });
});

describe("readNumber", () => {
  it("returns the first finite number value", () => {
    const meta = { a: "string", b: 42, c: 100 };
    expect(readNumber(meta, ["a", "b", "c"])).toBe(42);
  });

  it("returns undefined when no number found", () => {
    const meta = { a: "123", b: true, c: null };
    expect(readNumber(meta, ["a", "b", "c"])).toBeUndefined();
  });

  it("returns undefined for non-finite numbers", () => {
    const meta = { a: Infinity, b: NaN, c: 42 };
    expect(readNumber(meta, ["a", "b", "c"])).toBe(42);
    expect(readNumber({ a: Infinity }, ["a"])).toBeUndefined();
    expect(readNumber({ a: NaN }, ["a"])).toBeUndefined();
  });

  it("returns undefined for null/undefined meta", () => {
    expect(readNumber(null, ["a"])).toBeUndefined();
    expect(readNumber(undefined, ["a"])).toBeUndefined();
  });

  it("handles negative numbers and zero", () => {
    expect(readNumber({ a: -5 }, ["a"])).toBe(-5);
    expect(readNumber({ a: 0 }, ["a"])).toBe(0);
  });
});
