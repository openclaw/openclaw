import { describe, expect, it } from "vitest";
import { DEFAULT_ELEVENLABS_BASE_URL, normalizeElevenLabsBaseUrl } from "./shared.js";

describe("normalizeElevenLabsBaseUrl", () => {
  it("returns the default when undefined", () => {
    expect(normalizeElevenLabsBaseUrl()).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("returns the default for empty string", () => {
    expect(normalizeElevenLabsBaseUrl("")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("returns the default for whitespace", () => {
    expect(normalizeElevenLabsBaseUrl("   ")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("accepts valid https", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io")).toBe(
      "https://api.elevenlabs.io",
    );
  });

  it("accepts valid http", () => {
    expect(normalizeElevenLabsBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("strips trailing slash", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io/")).toBe(
      "https://api.elevenlabs.io",
    );
  });

  it("throws on invalid URL", () => {
    expect(() => normalizeElevenLabsBaseUrl("not a url")).toThrow(
      "Invalid ElevenLabs baseUrl: value is not a valid URL",
    );
  });

  it("throws on unsupported scheme", () => {
    expect(() => normalizeElevenLabsBaseUrl("ftp://files.example.com")).toThrow(
      'Invalid ElevenLabs baseUrl: unsupported scheme "ftp:" (expected http or https)',
    );
  });

  it("throws on ws scheme", () => {
    expect(() => normalizeElevenLabsBaseUrl("ws://stream.example.com")).toThrow(
      'Invalid ElevenLabs baseUrl: unsupported scheme "ws:" (expected http or https)',
    );
  });

  it("strips query string", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io?key=value")).toBe(
      "https://api.elevenlabs.io",
    );
  });

  it("strips fragment", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io#section")).toBe(
      "https://api.elevenlabs.io",
    );
  });

  it("strips both query and fragment", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io?key=v#anchor")).toBe(
      "https://api.elevenlabs.io",
    );
  });

  it("preserves explicit path", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io/v1")).toBe(
      "https://api.elevenlabs.io/v1",
    );
  });

  it("preserves path and strips query", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io/v1?key=v")).toBe(
      "https://api.elevenlabs.io/v1",
    );
  });

  it("preserves userinfo for proxy credentials", () => {
    expect(normalizeElevenLabsBaseUrl("https://user:pass@proxy.example.com/v1")).toBe(
      "https://user:pass@proxy.example.com/v1",
    );
  });

  it("preserves user-only userinfo", () => {
    expect(normalizeElevenLabsBaseUrl("https://user@proxy.example.com/v1")).toBe(
      "https://user@proxy.example.com/v1",
    );
  });
});
