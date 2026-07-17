import { describe, expect, it } from "vitest";
import { finiteNumber } from "./usage.js";

describe("Anthropic usage number parsing", () => {
  it("accepts canonical decimal numbers", () => {
    expect(finiteNumber(12.5)).toBe(12.5);
    expect(finiteNumber("12.5")).toBe(12.5);
    expect(finiteNumber("0")).toBe(0);
  });

  it("rejects malformed decimal strings", () => {
    expect(finiteNumber("1e1")).toBeUndefined();
    expect(finiteNumber("0x10")).toBeUndefined();
    expect(finiteNumber("12.5\n")).toBeUndefined();
    expect(finiteNumber(" 12.5 ")).toBeUndefined();
  });
});
