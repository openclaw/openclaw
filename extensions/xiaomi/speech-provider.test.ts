import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcodeAudioBufferToOpusMock = vi.hoisted(() => vi.fn());

const PROVIDER_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: transcodeAudioBufferToOpusMock,
}));

import { buildXiaomiSpeechProvider } from "./speech-provider.js";

function makeOversizedStreamResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PROVIDER_RESPONSE_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("buildXiaomiSpeechProvider", () => {
  const provider = buildXiaomiSpeechProvider();
  const synthesize = (overrides: Partial<SpeechSynthesisRequest> = {}) =>
    provider.synthesize({
      text: "Hello from OpenClaw.",
      cfg: {},
      providerConfig: { apiKey: "sk-test" },
      target: "audio-file",
      timeoutMs: 30000,
      ...overrides,
    });

  function mockAudioResponse(audio = "fake-mp3-audio") {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      Response.json({
        choices: [{ message: { audio: { data: Buffer.from(audio).toString("base64") } } }],
      }),
    );
  }

  describe("metadata", () => {
    it("registers Xiaomi MiMo as a speech provider", () => {
      expect(provider.id).toBe("xiaomi");
      expect(provider.aliases).toContain("mimo");
      expect(provider.models).toEqual(["mimo-v2.5-tts", "mimo-v2.5-tts-voicedesign"]);
      expect(provider.voices).toContain("mimo_default");
    });
  });

  describe("isConfigured", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns true when apiKey is in provider config", () => {
      expect(
        provider.isConfigured({ providerConfig: { apiKey: "sk-test" }, timeoutMs: 30000 }),
      ).toBe(true);
    });

    it("returns false when XIAOMI_API_KEY is whitespace-only", () => {
      vi.stubEnv("XIAOMI_API_KEY", "   ");
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30000 })).toBe(false);
    });
  });

  describe("resolveConfig", () => {
    it("reads providers.xiaomi settings with generic model and speaker voice aliases", () => {
      const config = provider.resolveConfig!({
        rawConfig: {
          providers: {
            xiaomi: {
              baseUrl: "https://example.com/v1/",
              modelId: "mimo-v2.5-tts-voicedesign",
              speakerVoice: "Chloe",
              format: "wav",
              style: "Bright and fast.",
            },
          },
        },
        cfg: {} as never,
        timeoutMs: 30000,
      });
      expect(config).toEqual({
        apiKey: undefined,
        baseUrl: "https://example.com/v1",
        model: "mimo-v2.5-tts-voicedesign",
        voice: "Chloe",
        format: "wav",
        style: "Bright and fast.",
      });
    });

    it("accepts the mimo provider config alias", () => {
      const config = provider.resolveConfig!({
        rawConfig: { providers: { mimo: { voiceId: "default_zh" } } },
        cfg: {} as never,
        timeoutMs: 30000,
      });
      expect(config.voice).toBe("default_zh");
    });
  });

  describe("parseDirectiveToken", () => {
    const policy = {
      enabled: true,
      allowText: true,
      allowProvider: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    };

    it("handles voice, model, style, and format tokens", () => {
      expect(provider.parseDirectiveToken!({ key: "voice", value: "default_en", policy })).toEqual({
        handled: true,
        overrides: { voice: "default_en" },
      });
      expect(
        provider.parseDirectiveToken!({ key: "model", value: "mimo-v2.5-tts", policy }),
      ).toEqual({ handled: true, overrides: { model: "mimo-v2.5-tts" } });
      expect(provider.parseDirectiveToken!({ key: "style", value: "whispered", policy })).toEqual({
        handled: true,
        overrides: { style: "whispered" },
      });
      expect(provider.parseDirectiveToken!({ key: "format", value: "wav", policy })).toEqual({
        handled: true,
        overrides: { format: "wav" },
      });
    });

    it("warns on invalid format", () => {
      const result = provider.parseDirectiveToken!({ key: "format", value: "ogg", policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("synthesize", () => {
    const savedFetch = globalThis.fetch;

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
      transcodeAudioBufferToOpusMock.mockReset();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      globalThis.fetch = savedFetch;
      vi.restoreAllMocks();
    });

    it("makes the Xiaomi chat completions TTS call and decodes audio", async () => {
      mockAudioResponse();
      const mockFetch = vi.mocked(globalThis.fetch);

      const result = await synthesize({
        providerConfig: {
          apiKey: "sk-test",
          model: "mimo-v2.5-tts",
          voice: "default_en",
          style: "Bright.",
        },
      });

      expect(result.outputFormat).toBe("mp3");
      expect(result.fileExtension).toBe(".mp3");
      expect(result.voiceCompatible).toBe(false);
      expect(result.audioBuffer.toString()).toBe("fake-mp3-audio");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] ?? [];
      expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
      expect(init?.headers).toEqual({
        "api-key": "sk-test",
        "Content-Type": "application/json",
      });
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("mimo-v2.5-tts");
      expect(body.messages).toEqual([
        { role: "user", content: "Bright." },
        { role: "assistant", content: "Hello from OpenClaw." },
      ]);
      expect(body.audio).toEqual({ format: "mp3", voice: "default_en" });
      expect(transcodeAudioBufferToOpusMock).not.toHaveBeenCalled();
    });

    it("rejects malformed base64 audio", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        Response.json({ choices: [{ message: { audio: { data: "ZE==" } } }] }),
      );

      await expect(synthesize()).rejects.toThrow(
        "Xiaomi TTS API returned malformed base64 audio data",
      );
    });

    it("omits voice and uses configured style for Xiaomi voice design models", async () => {
      mockAudioResponse("fake-wav-audio");
      const mockFetch = vi.mocked(globalThis.fetch);

      const result = await synthesize({
        providerConfig: {
          apiKey: "sk-test",
          modelId: "mimo-v2.5-tts-voicedesign",
          speakerVoice: "Chloe",
          format: "wav",
          style: "Warm, bright, natural voice.",
        },
      });

      expect(result.outputFormat).toBe("wav");
      expect(result.fileExtension).toBe(".wav");
      expect(result.voiceCompatible).toBe(false);
      expect(result.audioBuffer.toString()).toBe("fake-wav-audio");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] ?? [];
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("mimo-v2.5-tts-voicedesign");
      expect(body.messages).toEqual([
        { role: "user", content: "Warm, bright, natural voice." },
        { role: "assistant", content: "Hello from OpenClaw." },
      ]);
      expect(body.audio).toEqual({ format: "wav" });
    });

    it("transcodes Xiaomi voice design output to Opus for voice-note targets", async () => {
      mockAudioResponse("fake-wav-audio");
      transcodeAudioBufferToOpusMock.mockResolvedValueOnce(Buffer.from("fake-opus-audio"));

      const result = await synthesize({
        providerConfig: {
          apiKey: "sk-test",
          model: "mimo-v2.5-tts-voicedesign",
          format: "wav",
        },
        target: "voice-note",
      });

      expect(result.outputFormat).toBe("opus");
      expect(result.fileExtension).toBe(".opus");
      expect(result.voiceCompatible).toBe(true);
      expect(result.audioBuffer.toString()).toBe("fake-opus-audio");
      expect(transcodeAudioBufferToOpusMock).toHaveBeenCalledWith({
        audioBuffer: Buffer.from("fake-wav-audio"),
        inputExtension: "wav",
        tempPrefix: "tts-xiaomi-",
        timeoutMs: 30000,
      });
      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
      const body = JSON.parse(init!.body as string);
      expect(body.audio).toEqual({ format: "wav" });
      expect(body.messages).toEqual([
        { role: "user", content: expect.stringContaining("natural") },
        { role: "assistant", content: "Hello from OpenClaw." },
      ]);
    });

    it("caps oversized TTS request timeouts before scheduling or fetching", async () => {
      mockAudioResponse();
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      await synthesize({ timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000 });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    });

    it("rejects blank keys before building request credentials", async () => {
      vi.stubEnv("XIAOMI_API_KEY", "   ");
      await expect(synthesize({ providerConfig: { apiKey: "   " } })).rejects.toThrow(
        "Xiaomi API key missing",
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("trims a padded environment key before building the credential header", async () => {
      vi.stubEnv("XIAOMI_API_KEY", "  fake  ");
      mockAudioResponse();
      await synthesize({ providerConfig: {} });
      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
      expect(new Headers(init?.headers).get("api-key")).toBe("fake");
    });

    it("throws when the API response has no audio data", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        Response.json({ choices: [{ message: {} }] }),
      );
      await expect(synthesize()).rejects.toThrow("Xiaomi TTS API returned no audio data");
    });

    it("bounds oversized Xiaomi TTS success response reads", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeOversizedStreamResponse());

      await expect(synthesize()).rejects.toThrow(
        "Xiaomi TTS API: JSON response exceeds 16777216 bytes",
      );
    });
  });
});
