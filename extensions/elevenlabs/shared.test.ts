import { DEFAULT_ELEVENLABS_BASE_URL, normalizeElevenLabsBaseUrl } from "./shared.js";
import { describe, expect, it } from "vitest";

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
});
