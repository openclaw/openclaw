// Deepgram tests cover realtime transcription provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  buildDeepgramRealtimeTranscriptionProvider,
} from "./realtime-transcription-provider.js";

describe("buildDeepgramRealtimeTranscriptionProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const provider = buildDeepgramRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          deepgram: {
            apiKey: "dg-key",
            model: "nova-3",
            encoding: "g711_ulaw",
            sample_rate: "8000",
            interim_results: "true",
            endpointing: "500",
            language: "en-US",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "dg-key",
      baseUrl: undefined,
      model: "nova-3",
      language: "en-US",
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 500,
    });
  });

  it("builds a Deepgram listen websocket URL", () => {
    const url = testing.toDeepgramRealtimeWsUrl({
      apiKey: "dg-key",
      baseUrl: "https://api.deepgram.com/v1",
      model: "nova-3",
      providerConfig: {},
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 800,
    });

    expect(url).toContain("wss://api.deepgram.com/v1/listen?");
    expect(url).toContain("model=nova-3");
    expect(url).toContain("encoding=mulaw");
    expect(url).toContain("sample_rate=8000");
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    const provider = buildDeepgramRealtimeTranscriptionProvider();
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "Deepgram API key missing",
    );
  });
});

describe("normalizeDeepgramRealtimeBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the default when no value or env is set", () => {
    vi.stubEnv("DEEPGRAM_BASE_URL", "");
    expect(testing.normalizeDeepgramRealtimeBaseUrl(undefined)).toBe("https://api.deepgram.com/v1");
    expect(testing.normalizeDeepgramRealtimeBaseUrl("   ")).toBe("https://api.deepgram.com/v1");
  });

  it("accepts a valid explicit http(s) endpoint", () => {
    expect(testing.normalizeDeepgramRealtimeBaseUrl("https://custom.example.com")).toBe(
      "https://custom.example.com",
    );
  });

  it("rejects an explicit malformed override instead of silently retargeting", () => {
    // An operator's explicit endpoint must not be swapped for the default, and a
    // downstream `new URL(...)` must never throw an opaque TypeError.
    expect(() => testing.normalizeDeepgramRealtimeBaseUrl("not a url")).toThrow(
      /Invalid Deepgram baseUrl/,
    );
  });

  it("rejects a parseable but unsupported (non-HTTP(S)) scheme", () => {
    expect(() => testing.normalizeDeepgramRealtimeBaseUrl("ftp://files.example.com")).toThrow(
      /unsupported scheme/,
    );
  });

  it("does not leak URL credentials or sensitive query values in validation errors", () => {
    const nonHttp = "ftp://user:sup3r-secret@files.example.com/x?api_key=leak-me";
    try {
      testing.normalizeDeepgramRealtimeBaseUrl(nonHttp);
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/unsupported scheme/);
      expect(message).not.toContain("sup3r-secret");
      expect(message).not.toContain("leak-me");
      expect(message).not.toContain("api_key");
    }
  });
});
