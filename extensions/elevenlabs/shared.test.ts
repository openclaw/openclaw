import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELEVENLABS_BASE_URL,
  normalizeElevenLabsBaseUrl,
  normalizeElevenLabsRealtimeBaseUrl,
} from "./shared.js";

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

  it.each([
    ["http://:not a url token=abcd1234secret", "value is not a valid URL"],
    [
      "ftp://user:sup3r-secret@files.example.com/x?api_key=leak-me",
      'unsupported scheme "ftp:" (expected http: or https:)',
    ],
  ])("rejects %s without leaking credentials or retargeting", (input, detail) => {
    expect(() => normalizeElevenLabsBaseUrl(input)).toThrow(
      new Error(`Invalid ElevenLabs baseUrl: ${detail}`),
    );
  });

  it("maps HTTP endpoints and preserves explicit WebSocket endpoints for realtime", () => {
    expect(normalizeElevenLabsRealtimeBaseUrl("https://api.example.com/")).toBe(
      "wss://api.example.com",
    );
    expect(normalizeElevenLabsRealtimeBaseUrl("wss://realtime.example.com/")).toBe(
      "wss://realtime.example.com",
    );
    expect(normalizeElevenLabsRealtimeBaseUrl("ws://localhost:8080/")).toBe("ws://localhost:8080");
  });
});
