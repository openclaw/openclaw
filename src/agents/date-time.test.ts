import { describe, expect, it } from "vitest";
import { normalizeTimestamp } from "./date-time.js";

describe("normalizeTimestamp", () => {
  it("returns undefined for null and undefined", () => {
    expect(normalizeTimestamp(null)).toBeUndefined();
    expect(normalizeTimestamp(undefined)).toBeUndefined();
  });

  describe("Date input", () => {
    it("parses Date objects", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = normalizeTimestamp(date);
      expect(result?.timestampMs).toBe(date.getTime());
      expect(result?.timestampUtc).toBe("2024-01-15T10:30:00.000Z");
    });
  });

  describe("number input (seconds)", () => {
    it("converts seconds to milliseconds", () => {
      const result = normalizeTimestamp(1705315800);
      expect(result?.timestampMs).toBe(1705315800000);
    });

    it("interprets numbers < 1e12 as seconds", () => {
      const result = normalizeTimestamp(1705315800);
      expect(result?.timestampUtc).toContain("2024");
    });
  });

  describe("number input (milliseconds)", () => {
    it("keeps milliseconds as-is", () => {
      const result = normalizeTimestamp(1705315800000);
      expect(result?.timestampMs).toBe(1705315800000);
    });
  });

  describe("number edge cases", () => {
    it("returns undefined for NaN and Infinity", () => {
      expect(normalizeTimestamp(NaN)).toBeUndefined();
      expect(normalizeTimestamp(Infinity)).toBeUndefined();
    });

    it("handles floating point", () => {
      const result = normalizeTimestamp(1705315.8);
      expect(result?.timestampMs).toBe(1705315800);
    });
  });

  describe("string input", () => {
    it("parses ISO 8601 strings", () => {
      const result = normalizeTimestamp("2024-01-15T10:30:00Z");
      expect(result?.timestampUtc).toBe("2024-01-15T10:30:00.000Z");
    });

    it("parses numeric strings as seconds or ms", () => {
      expect(normalizeTimestamp("1705315800")?.timestampMs).toBe(1705315800000);
      expect(normalizeTimestamp("1705315800000")?.timestampMs).toBe(1705315800000);
    });

    it("parses decimal numeric strings", () => {
      const result = normalizeTimestamp("1705315.8");
      expect(result?.timestampMs).toBe(1705315800);
    });

    it("returns undefined for empty strings", () => {
      expect(normalizeTimestamp("")).toBeUndefined();
      expect(normalizeTimestamp("   ")).toBeUndefined();
    });

    it("returns undefined for non-parseable strings", () => {
      expect(normalizeTimestamp("not-a-date")).toBeUndefined();
      expect(normalizeTimestamp("hello world")).toBeUndefined();
    });
  });

  it("returns undefined for invalid input types", () => {
    expect(normalizeTimestamp({} as any)).toBeUndefined();
    expect(normalizeTimestamp([] as any)).toBeUndefined();
    expect(normalizeTimestamp(true as any)).toBeUndefined();
  });
});

describe("normalizeTimestamp consistency", () => {
  it("produces consistent ISO string format", () => {
    const result = normalizeTimestamp("2024-06-15T12:00:00Z");
    expect(result?.timestampUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});
