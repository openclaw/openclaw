// Elevenlabs tests cover realtime transcription provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  testing,
  buildElevenLabsRealtimeTranscriptionProvider,
} from "./realtime-transcription-provider.js";

describe("buildElevenLabsRealtimeTranscriptionProvider", () => {
  it("normalizes nested provider config", () => {
    const provider = buildElevenLabsRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          elevenlabs: {
            apiKey: "eleven-key",
            model_id: "scribe_v2_realtime",
            audio_format: "ulaw_8000",
            sample_rate: "8000",
            commit_strategy: "vad",
            language: "en",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "eleven-key",
      baseUrl: undefined,
      modelId: undefined,
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
      languageCode: "en",
      vadSilenceThresholdSecs: undefined,
      vadThreshold: undefined,
      minSpeechDurationMs: undefined,
      minSilenceDurationMs: undefined,
    });
  });

  it("drops malformed numeric realtime config values", () => {
    const provider = buildElevenLabsRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          elevenlabs: {
            sample_rate: "8000.5",
            vad_silence_threshold_secs: "999",
            vad_threshold: "0",
            min_speech_duration_ms: "0",
            min_silence_duration_ms: "10.5",
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      sampleRate: undefined,
      vadSilenceThresholdSecs: undefined,
      vadThreshold: undefined,
      minSpeechDurationMs: undefined,
      minSilenceDurationMs: undefined,
    });
  });

  it("keeps realtime VAD numeric config inside provider ranges", () => {
    const provider = buildElevenLabsRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          elevenlabs: {
            sample_rate: "8000",
            vad_silence_threshold_secs: "3",
            vad_threshold: "0.9",
            min_speech_duration_ms: "50",
            min_silence_duration_ms: "2000",
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      sampleRate: 8000,
      vadSilenceThresholdSecs: 3,
      vadThreshold: 0.9,
      minSpeechDurationMs: 50,
      minSilenceDurationMs: 2000,
    });
  });

  describe("normalizeElevenLabsRealtimeBaseUrl", () => {
    it("returns default URL when undefined", () => {
      expect(testing.normalizeElevenLabsRealtimeBaseUrl(undefined)).toBe(
        "https://api.elevenlabs.io",
      );
    });

    it("returns default URL when empty string", () => {
      expect(testing.normalizeElevenLabsRealtimeBaseUrl("")).toBe("https://api.elevenlabs.io");
    });

    it("accepts HTTPS URL", () => {
      expect(testing.normalizeElevenLabsRealtimeBaseUrl("https://custom.example.com")).toBe(
        "https://custom.example.com",
      );
    });

    it("accepts HTTP URL", () => {
      expect(testing.normalizeElevenLabsRealtimeBaseUrl("http://localhost:8080")).toBe(
        "http://localhost:8080",
      );
    });

    it("accepts WS URL for direct WebSocket endpoints", () => {
      expect(testing.normalizeElevenLabsRealtimeBaseUrl("ws://localhost:9090/audio")).toBe(
        "ws://localhost:9090/audio",
      );
    });

    it("accepts WSS URL for direct WebSocket endpoints", () => {
      expect(
        testing.normalizeElevenLabsRealtimeBaseUrl("wss://custom-realtime.example.com/endpoint"),
      ).toBe("wss://custom-realtime.example.com/endpoint");
    });

    it("throws descriptive error for invalid URL", () => {
      expect(() => testing.normalizeElevenLabsRealtimeBaseUrl("not a url")).toThrow(
        "Invalid ElevenLabs baseUrl: value is not a valid URL",
      );
    });

    it("throws descriptive error for unsupported scheme", () => {
      expect(() => testing.normalizeElevenLabsRealtimeBaseUrl("ftp://files.example.com")).toThrow(
        'Invalid ElevenLabs baseUrl: unsupported scheme "ftp:" (expected http, https, ws, or wss)',
      );
    });
  });

  it("builds an ElevenLabs realtime websocket URL", () => {
    const url = testing.toElevenLabsRealtimeWsUrl({
      apiKey: "eleven-key",
      baseUrl: "https://api.elevenlabs.io",
      providerConfig: {},
      modelId: "scribe_v2_realtime",
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
      languageCode: "en",
    });

    expect(url).toContain("wss://api.elevenlabs.io/v1/speech-to-text/realtime?");
    expect(url).toContain("model_id=scribe_v2_realtime");
    expect(url).toContain("audio_format=ulaw_8000");
    expect(url).toContain("commit_strategy=vad");
    expect(url).toContain("language_code=en");
  });

  it("preserves direct WSS endpoint in WebSocket URL", () => {
    const url = testing.toElevenLabsRealtimeWsUrl({
      apiKey: "eleven-key",
      baseUrl: "wss://custom-realtime.example.com",
      providerConfig: {},
      modelId: "scribe_v2_realtime",
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "manual",
    });

    expect(url).toContain("wss://custom-realtime.example.com/v1/speech-to-text/realtime?");
    expect(url).toContain("model_id=scribe_v2_realtime");
  });

  it("preserves direct WS endpoint in WebSocket URL", () => {
    const url = testing.toElevenLabsRealtimeWsUrl({
      apiKey: "eleven-key",
      baseUrl: "ws://localhost:9090",
      providerConfig: {},
      modelId: "scribe_v2_realtime",
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "manual",
    });

    expect(url).toContain("ws://localhost:9090/v1/speech-to-text/realtime?");
  });

  it("converts HTTPS to WSS in WebSocket URL", () => {
    const url = testing.toElevenLabsRealtimeWsUrl({
      apiKey: "eleven-key",
      baseUrl: "https://api.elevenlabs.io",
      providerConfig: {},
      modelId: "scribe_v2_realtime",
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
    });

    expect(url).toMatch(/^wss:\/\//);
  });

  it("converts HTTP to WS in WebSocket URL", () => {
    const url = testing.toElevenLabsRealtimeWsUrl({
      apiKey: "eleven-key",
      baseUrl: "http://localhost:8080",
      providerConfig: {},
      modelId: "scribe_v2_realtime",
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
    });

    expect(url).toMatch(/^ws:\/\//);
  });
});
