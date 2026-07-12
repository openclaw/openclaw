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
    expect(normalizeElevenLabsBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("rejects an explicit malformed override instead of silently retargeting", () => {
    // An operator's explicit endpoint must not be swapped for the default; fail
    // actionably here so the request cannot target an unintended host, and so a
    // downstream `new URL(...)` never throws an opaque TypeError.
    expect(() => normalizeElevenLabsBaseUrl("not a url")).toThrow(/Invalid ElevenLabs baseUrl/);
  });

  it("rejects a parseable but unsupported (non-HTTP(S)) scheme", () => {
    // `new URL()` accepts ftp:/data:/custom schemes, but downstream fetch and
    // WebSocket paths only support http(s) ElevenLabs endpoints.
    expect(() => normalizeElevenLabsBaseUrl("ftp://files.example.com")).toThrow(
      /expected http\/https/,
    );
    expect(() => normalizeElevenLabsBaseUrl("data:text/plain,x")).toThrow(/expected http\/https/);
  });

  it("keeps every accepted result parseable as an http(s) URL", () => {
    for (const input of ["https://ok.example.com/", "http://a.b:9000"]) {
      const normalized = normalizeElevenLabsBaseUrl(input);
      const url = new URL(normalized);
      expect(["http:", "https:"]).toContain(url.protocol);
    }
  });
});
