import { describe, expect, it } from "vitest";
import { DEFAULT_ELEVENLABS_BASE_URL, normalizeElevenLabsBaseUrl } from "./shared.js";

describe("normalizeElevenLabsBaseUrl", () => {
  it("returns the default when the base URL is missing or blank", () => {
    expect(normalizeElevenLabsBaseUrl(undefined)).toBe(DEFAULT_ELEVENLABS_BASE_URL);
    expect(normalizeElevenLabsBaseUrl("   ")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("trims and strips trailing slashes from a valid URL", () => {
    expect(normalizeElevenLabsBaseUrl("  https://custom.example.com/  ")).toBe(
      "https://custom.example.com",
    );
  });

  it("falls back to the default for a malformed URL instead of yielding an unparseable value", () => {
    // Callers feed the result straight into `new URL(...)`; a malformed value
    // would otherwise throw an uncaught TypeError downstream.
    const normalized = normalizeElevenLabsBaseUrl("not a url");
    expect(normalized).toBe(DEFAULT_ELEVENLABS_BASE_URL);
    expect(() => new URL(normalized)).not.toThrow();
  });

  it("keeps every normalized result parseable by new URL", () => {
    for (const input of ["not a url", "", "://broken", "https://ok.example.com/"]) {
      expect(() => new URL(normalizeElevenLabsBaseUrl(input))).not.toThrow();
    }
  });
});
