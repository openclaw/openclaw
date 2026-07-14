// Elevenlabs tests cover shared helpers.
import { describe, expect, it } from "vitest";
import { DEFAULT_ELEVENLABS_BASE_URL, normalizeElevenLabsBaseUrl } from "./shared.js";

describe("normalizeElevenLabsBaseUrl", () => {
  it("returns default URL when undefined", () => {
    expect(normalizeElevenLabsBaseUrl(undefined)).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("returns default URL when empty string", () => {
    expect(normalizeElevenLabsBaseUrl("")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("returns default URL when whitespace only", () => {
    expect(normalizeElevenLabsBaseUrl("   ")).toBe(DEFAULT_ELEVENLABS_BASE_URL);
  });

  it("passes through a valid HTTPS URL", () => {
    expect(normalizeElevenLabsBaseUrl("https://api.elevenlabs.io")).toBe(
      "https://api.elevenlabs.io",
    );
  });

  it("passes through a valid HTTP URL", () => {
    expect(normalizeElevenLabsBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("strips trailing slash", () => {
    expect(normalizeElevenLabsBaseUrl("https://custom.example.com/")).toBe(
      "https://custom.example.com",
    );
  });

  it("preserves search params for custom endpoints", () => {
    expect(normalizeElevenLabsBaseUrl("https://custom.example.com/path?version=2")).toBe(
      "https://custom.example.com/path?version=2",
    );
  });

  it("preserves hash for custom endpoints", () => {
    expect(normalizeElevenLabsBaseUrl("https://custom.example.com/path#section")).toBe(
      "https://custom.example.com/path#section",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeElevenLabsBaseUrl("  https://api.elevenlabs.io  ")).toBe(
      "https://api.elevenlabs.io",
    );
  });

  it("throws descriptive error for invalid URL", () => {
    expect(() => normalizeElevenLabsBaseUrl("not a url")).toThrow(
      "Invalid ElevenLabs baseUrl: value is not a valid URL",
    );
  });

  it("throws descriptive error for unsupported scheme (ftp)", () => {
    expect(() => normalizeElevenLabsBaseUrl("ftp://files.example.com")).toThrow(
      'Invalid ElevenLabs baseUrl: unsupported scheme "ftp:" (expected http or https)',
    );
  });

  it("throws descriptive error for unsupported scheme (ws)", () => {
    expect(() => normalizeElevenLabsBaseUrl("ws://localhost:8080/audio")).toThrow(
      'Invalid ElevenLabs baseUrl: unsupported scheme "ws:" (expected http or https)',
    );
  });
});
