// Covers safe formatting of circular non-Error rejections for stream catch paths.
import { describe, expect, it } from "vitest";
import { formatUnknownError } from "./format-unknown-error.js";

describe("formatUnknownError", () => {
  it("prefers Error.message", () => {
    expect(formatUnknownError(new Error("boom"))).toBe("boom");
  });

  it("JSON-stringifies ordinary non-Error values", () => {
    expect(formatUnknownError({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
    expect(formatUnknownError("plain")).toBe('"plain"');
    expect(formatUnknownError(42)).toBe("42");
  });

  it("falls back to String for circular structures without throwing", () => {
    const circular: Record<string, unknown> = { kind: "provider-reject" };
    circular.self = circular;
    expect(() => JSON.stringify(circular)).toThrow();
    const formatted = formatUnknownError(circular);
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted).toContain("Object");
  });
});
