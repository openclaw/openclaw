// Codex tests cover command handler behavior.
import { describe, expect, it } from "vitest";
import { normalizeDiagnosticsReason } from "./command-handlers.js";

describe("normalizeDiagnosticsReason", () => {
  it("returns undefined for empty input", () => {
    expect(normalizeDiagnosticsReason("")).toBeUndefined();
    expect(normalizeDiagnosticsReason("   ")).toBeUndefined();
  });

  it("returns the original string when within the char limit", () => {
    expect(normalizeDiagnosticsReason("short reason")).toBe("short reason");
  });

  it("truncates long reasons", () => {
    const input = "x".repeat(3_000);
    const result = normalizeDiagnosticsReason(input);
    expect(result?.length).toBeLessThanOrEqual(2048);
  });

  it("does not split a surrogate pair at the truncation boundary", () => {
    // 2047 'x's + rocket emoji (2 UTF-16 code units) = 2049 code units.
    // On main, slice(0, 2048) cuts between the pair, leaving an orphan high
    // surrogate (U+D83D) at the end.
    //
    // truncateUtf16Safe detects the boundary split and backs off by one code
    // unit (returning 2047 chars) so the partial emoji is dropped cleanly.
    const input = `${"x".repeat(2047)}\u{1F680}`;
    const result = normalizeDiagnosticsReason(input);
    expect(result).toBeDefined();
    // truncateUtf16Safe backs off by one to avoid the split: 2048 → 2047
    expect(result!.length).toBe(2047);
    // The final code unit must not be an orphan high surrogate
    const lastCode = result!.codePointAt(result!.length - 1);
    expect(lastCode).toBe(0x78); // 'x'
  });
});
