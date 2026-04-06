import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MINIMAX_TTS_BASE_URL,
  MINIMAX_TTS_MODELS,
  MINIMAX_TTS_VOICES,
  minimaxTTS,
  normalizeMinimaxTtsBaseUrl,
} from "./tts.js";

describe("minimax tts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("normalizeMinimaxTtsBaseUrl", () => {
    it("returns the default URL when no input is provided", () => {
      expect(normalizeMinimaxTtsBaseUrl()).toBe(DEFAULT_MINIMAX_TTS_BASE_URL);
      expect(normalizeMinimaxTtsBaseUrl("")).toBe(DEFAULT_MINIMAX_TTS_BASE_URL);
      expect(normalizeMinimaxTtsBaseUrl("   ")).toBe(DEFAULT_MINIMAX_TTS_BASE_URL);
    });

    it("strips trailing slashes", () => {
      expect(normalizeMinimaxTtsBaseUrl("https://api.minimax.io/v1/")).toBe(
        "https://api.minimax.io/v1",
      );
      expect(normalizeMinimaxTtsBaseUrl("https://api.minimax.io/v1///")).toBe(
        "https://api.minimax.io/v1",
      );
    });
  });

  describe("model and voice lists", () => {
    it("exposes the expected model set", () => {
      expect(MINIMAX_TTS_MODELS).toContain("speech-2.8-hd");
      expect(MINIMAX_TTS_MODELS).toContain("speech-2.8-turbo");
      expect(MINIMAX_TTS_MODELS.length).toBeGreaterThanOrEqual(8);
    });

    it("exposes the expected voice set", () => {
      expect(MINIMAX_TTS_VOICES).toContain("English_expressive_narrator");
      expect(MINIMAX_TTS_VOICES.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("minimaxTTS sends integer values for speed/vol/pitch (#62144)", () => {
    it("truncates float speed/vol/pitch to integers in the request body", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      const hexAudio = Buffer.from("test-audio").toString("hex");
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: { audio: hexAudio, status: 2 },
            base_resp: { status_code: 0, status_msg: "success" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await minimaxTTS({
        text: "Hello",
        apiKey: "test-key",
        baseUrl: "https://api.minimax.io/v1",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        speed: 1.0,
        vol: 1.0,
        pitch: 0.0,
        timeoutMs: 5_000,
      });

      expect(capturedBody).toBeDefined();
      const voiceSetting = capturedBody!.voice_setting as Record<string, unknown>;
      expect(voiceSetting.speed).toBe(1);
      expect(voiceSetting.vol).toBe(1);
      expect(voiceSetting.pitch).toBe(0);
      expect(Number.isInteger(voiceSetting.speed)).toBe(true);
      expect(Number.isInteger(voiceSetting.vol)).toBe(true);
      expect(Number.isInteger(voiceSetting.pitch)).toBe(true);
    });

    it("truncates fractional values rather than rounding", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      const hexAudio = Buffer.from("test-audio").toString("hex");
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: { audio: hexAudio, status: 2 },
            base_resp: { status_code: 0, status_msg: "success" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await minimaxTTS({
        text: "Hello",
        apiKey: "test-key",
        baseUrl: "https://api.minimax.io/v1",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        speed: 1.7,
        vol: 2.9,
        pitch: -3.5,
        timeoutMs: 5_000,
      });

      expect(capturedBody).toBeDefined();
      const voiceSetting = capturedBody!.voice_setting as Record<string, unknown>;
      expect(voiceSetting.speed).toBe(1);
      expect(voiceSetting.vol).toBe(2);
      expect(voiceSetting.pitch).toBe(-3);
    });
  });

  describe("minimaxTTS error handling", () => {
    it("throws on HTTP-level errors with detail from base_resp", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              base_resp: {
                status_code: 2013,
                status_msg: "invalid params, Mismatch type int64 with value null",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        minimaxTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: "https://api.minimax.io/v1",
          model: "speech-2.8-hd",
          voiceId: "English_expressive_narrator",
          speed: 1,
          vol: 1,
          pitch: 0,
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("MiniMax TTS API error");
    });

    it("throws when no audio data is returned", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: { audio: null, status: 2 },
              base_resp: { status_code: 0, status_msg: "success" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        minimaxTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: "https://api.minimax.io/v1",
          model: "speech-2.8-hd",
          voiceId: "English_expressive_narrator",
          speed: 1,
          vol: 1,
          pitch: 0,
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("MiniMax TTS API returned no audio data");
    });

    it("throws on non-OK HTTP status with error detail", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              base_resp: { status_code: 1004, status_msg: "authentication failed" },
            }),
            { status: 401 },
          ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        minimaxTTS({
          text: "hello",
          apiKey: "bad-key",
          baseUrl: "https://api.minimax.io/v1",
          model: "speech-2.8-hd",
          voiceId: "English_expressive_narrator",
          speed: 1,
          vol: 1,
          pitch: 0,
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("MiniMax TTS API error (401): authentication failed [status_code=1004]");
    });
  });

  describe("minimaxTTS request format", () => {
    it("sends the correct request structure to the t2a_v2 endpoint", async () => {
      let capturedUrl: string | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      const hexAudio = Buffer.from("test-audio").toString("hex");
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: { audio: hexAudio, status: 2 },
            base_resp: { status_code: 0, status_msg: "success" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await minimaxTTS({
        text: "Hello world",
        apiKey: "test-key",
        baseUrl: "https://api.minimax.io/v1",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        speed: 1,
        vol: 1,
        pitch: 0,
        emotion: "happy",
        languageBoost: "English",
        audioFormat: "mp3",
        timeoutMs: 10_000,
      });

      expect(capturedUrl).toBe("https://api.minimax.io/v1/t2a_v2");
      expect(capturedBody).toMatchObject({
        model: "speech-2.8-hd",
        text: "Hello world",
        stream: false,
        output_format: "hex",
        language_boost: "English",
        voice_setting: {
          voice_id: "English_expressive_narrator",
          speed: 1,
          vol: 1,
          pitch: 0,
          emotion: "happy",
        },
        audio_setting: {
          format: "mp3",
        },
      });
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe("test-audio");
    });
  });
});
