import { describe, expect, it } from "vitest";
import { expectDefined } from "./expect.js";

describe("expect helpers", () => {
  it("returns defined values", () => {
    expect(expectDefined(0, "number")).toBe(0);
  });

  it.each([null, undefined])("rejects missing values", (value) => {
    expect(() => expectDefined(value, "test value")).toThrow("expected test value to be defined");
  });
});
