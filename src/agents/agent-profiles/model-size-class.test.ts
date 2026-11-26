import { describe, expect, it } from "vitest";
import { resolveProfileModelSizeClass } from "./model-size-class.js";

describe("resolveProfileModelSizeClass", () => {
  it.each([
    [1, "tiny"],
    [1e9, "tiny"],
    [1e9 + 1, "small"],
    [20e9, "small"],
    [20e9 + 1, "medium"],
    [50e9, "medium"],
    [50e9 + 1, "large"],
    [8_190_735_360, "small"],
    [34_660_610_688, "medium"],
    [748_494_643_824, "large"],
  ] as const)("classifies %d total parameters as %s", (parameterCount, expected) => {
    expect(resolveProfileModelSizeClass({ parameterCount })).toBe(expected);
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    "rejects invalid count %s",
    (parameterCount) => {
      expect(resolveProfileModelSizeClass({ parameterCount })).toBeUndefined();
    },
  );

  it("prefers the explicit config class over the count", () => {
    expect(
      resolveProfileModelSizeClass({ modelSizeClass: "large", parameterCount: 8_190_735_360 }),
    ).toBe("large");
  });

  it("returns undefined when nothing trusted is present", () => {
    expect(resolveProfileModelSizeClass({})).toBeUndefined();
    expect(resolveProfileModelSizeClass(undefined)).toBeUndefined();
  });
});
