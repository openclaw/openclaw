import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
import { describe, expect, it } from "vitest";

describe("normalization-core/boolean-coercion", () => {
  it.each([
    [true, true],
    [false, false],
    [" FALSE ", false],
    ["TrUe", true],
  ])("parses %j as %s", (value, expected) => {
    expect(parseBoolean(value)).toBe(expected);
  });

  it.each([undefined, 1, "yes", "1"])("rejects unsupported value %j", (value) => {
    expect(parseBoolean(value)).toBeUndefined();
  });
});
