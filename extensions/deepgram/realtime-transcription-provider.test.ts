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

  it("accepts a direct wss:// endpoint — released behavior preserved", () => {
    // v2026.6.11 passed wss:// overrides straight through; validate must not reject them.
    expect(testing.normalizeDeepgramRealtimeBaseUrl("wss://api.deepgram.com/v1")).toBe(
      "wss://api.deepgram.com/v1",
    );
  });

  it("accepts a direct ws:// endpoint but upgrades it to wss:// in the URL builder", () => {
    // The validator accepts ws://, but the released behavior upgrades ws:// to
    // secure wss:// — realtime audio and provider auth must not go plaintext.
    expect(testing.normalizeDeepgramRealtimeBaseUrl("ws://internal.proxy:8080/dg")).toBe(
      "ws://internal.proxy:8080/dg",
    );
    const url = testing.toDeepgramRealtimeWsUrl({
      apiKey: "dg-key",
      baseUrl: "ws://internal.proxy:8080/dg",
      model: "nova-3",
      providerConfig: {},
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 800,
    });
    expect(url).toMatch(/^wss:\/\/internal\.proxy:8080\/dg\/listen\?/);
  });

  it("preserves custom path on a wss:// override through the URL builder", () => {
    const url = testing.toDeepgramRealtimeWsUrl({
      apiKey: "dg-key",
      baseUrl: "wss://proxy.example.com/deepgram/v1",
      model: "nova-3",
      providerConfig: {},
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 800,
    });
    // Protocol preserved; /listen appended to the custom path.
    expect(url).toMatch(/^wss:\/\/proxy\.example\.com\/deepgram\/v1\/listen\?/);
  });

  it("preserves custom port on a wss:// override through the URL builder", () => {
    const url = testing.toDeepgramRealtimeWsUrl({
      apiKey: "dg-key",
      baseUrl: "wss://proxy.example.com:9090",
      model: "nova-3",
      providerConfig: {},
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 800,
    });
    expect(url).toMatch(/^wss:\/\/proxy\.example\.com:9090\/listen\?/);
  });

  it("rejects a parseable but unsupported (non-WebSocket non-HTTP) scheme", () => {
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
