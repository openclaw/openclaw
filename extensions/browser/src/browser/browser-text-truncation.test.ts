// Browser tests cover UTF-16-safe text truncation.
import { describe, expect, it } from "vitest";

describe("UTF-16-safe text truncation", () => {
  it("keeps ASCII text within the limit", () => {
    const text = "hello world";
    const result = text.slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");
    expect(result).toBe("hello world");
  });

  it("truncates long ASCII text at the code-unit boundary", () => {
    const text = "x".repeat(120);
    const result = text.slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");
    expect(result).toBe("x".repeat(100));
  });

  it("removes a dangling high surrogate at the truncation boundary", () => {
    // 😀 (U+1F600) is D83D DE00 in UTF-16. slice(0, 100) on a string with
    // 99 ASCII + 😀 ends at D83D — a dangling high surrogate. The .replace()
    // strips it.
    const text = "x".repeat(99) + "😀tail";
    const result = text.slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");
    expect(result).toBe("x".repeat(99));
    expect(result).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("keeps a complete surrogate pair when it fits before the boundary", () => {
    const text = "x".repeat(50) + "😀" + "y".repeat(48);
    const result = text.slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");
    // 😀 at code units 50-51, fits entirely within 100.
    expect(result).toBe(text);
    expect(result).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("handles empty string", () => {
    expect("".slice(0, 100).replace(/[\uD800-\uDBFF]$/, "")).toBe("");
  });

  it("preserves the UTF-16 code-unit cap", () => {
    // Each emoji is 2 code units. 51 ASCII + 25 emoji = 51 + 50 = 101 code units.
    // slice(0, 100) takes 51 ASCII + 24 emoji + the 25th emoji's high surrogate
    // at position 99. The .replace() strips the dangling high surrogate.
    const text = "x".repeat(51) + "😀".repeat(25) + "tail";
    const result = text.slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");
    expect(result).toBe("x".repeat(51) + "😀".repeat(24));
    expect(result).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});
