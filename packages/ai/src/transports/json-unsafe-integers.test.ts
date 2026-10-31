import { describe, expect, it } from "vitest";
import {
  parseJsonObjectPreservingUnsafeIntegers,
  parseJsonPreservingUnsafeIntegers,
  quoteUnsafeIntegerLiterals,
} from "./json-unsafe-integers.js";

describe("unsafe integer JSON preservation", () => {
  it.each([
    ["9007199254740991", "9007199254740991"],
    ["9007199254740992", '"9007199254740992"'],
    ["-9007199254740992", '"-9007199254740992"'],
    ["9007199254740992.0", "9007199254740992.0"],
    ["9007199254740992e-2", "9007199254740992e-2"],
    ["1E+20", "1E+20"],
    ['"9007199254740992"', '"9007199254740992"'],
    ['"escaped \\\"9007199254740992\\\""', '"escaped \\\"9007199254740992\\\""'],
    ['"slash \\\\9007199254740992"', '"slash \\\\9007199254740992"'],
    ["9007199254740993.", "9007199254740993."],
    ["9007199254740993e", "9007199254740993e"],
    ["9007199254740993E+", "9007199254740993E+"],
    ["9007199254740993.e9007199254740993", '9007199254740993.e"9007199254740993"'],
  ])("preserves lexical token %s", (input, expected) => {
    expect(quoteUnsafeIntegerLiterals(input)).toBe(expected);
  });

  it("preserves nested integer values without changing strings or floating-point values", () => {
    expect(
      parseJsonPreservingUnsafeIntegers(
        '{"ids":[9223372036854775807,-9223372036854775808],"text":"日本語😀 9223372036854775807","fraction":9007199254740992.0,"exponent":1e20,"safe":42}',
      ),
    ).toEqual({
      ids: ["9223372036854775807", "-9223372036854775808"],
      text: "日本語😀 9223372036854775807",
      fraction: 9007199254740992,
      exponent: 1e20,
      safe: 42,
    });
  });

  it.each(["09007199254740993", "9007199254740993.", "9007199254740993e", '"9007199254740993'])(
    "does not repair invalid JSON %s",
    (input) => {
      expect(() => parseJsonPreservingUnsafeIntegers(input)).toThrow(SyntaxError);
      expect(parseJsonObjectPreservingUnsafeIntegers(input)).toBeNull();
    },
  );

  it("accepts object values without cloning them", () => {
    const value = { id: "9223372036854775807" };
    expect(parseJsonObjectPreservingUnsafeIntegers(value)).toBe(value);
  });
});
