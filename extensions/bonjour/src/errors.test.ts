import { describe, expect, it } from "vitest";
import { formatBonjourError } from "./errors.js";

describe("formatBonjourError", () => {
  it("treats whitespace-only messages as blank", () => {
    const named = new Error("   ");
    named.name = "AbortError";
    expect(formatBonjourError(named)).toBe("AbortError");

    expect(formatBonjourError(new Error("   "))).toBe("Error");
  });

  it("falls back to plain error strings and non-error values", () => {
    expect(formatBonjourError(new Error(""))).toBe("Error");
    expect(formatBonjourError("boom")).toBe("boom");
    expect(formatBonjourError(42)).toBe("42");
  });
});
