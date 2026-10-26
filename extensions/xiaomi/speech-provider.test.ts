import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";
import { createClosedChunkStream } from "../test-support/streaming-error-response.js";

const transcodeMock = vi.hoisted(() => vi.fn());

// mock-isolation: Capture speech transcoding without invoking ffmpeg.
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({ transcodeAudioBufferToOpus: transcodeMock }));

import { buildXiaomiSpeechProvider } from "./speech-provider.js";

function makeOversizedStreamResponse(): Response {
  const body = createClosedChunkStream([new Uint8Array(16 * 1024 * 1024), new Uint8Array(1)]);
  return new Response(body);
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

  function mockResponse(data?: string) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      Response.json({ choices: [{ message: data ? { audio: { data } } : {} }] }),
    );
  }
  const mockAudioResponse = (audio = "fake-mp3-audio") =>
    mockResponse(Buffer.from(audio).toString("base64"));
  const requestInit = () => vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
  const resolveConfig = (providers: Record<string, unknown>) =>
    provider.resolveConfig!({ rawConfig: { providers }, cfg: {}, timeoutMs: 30000 });

  it("reads providers.xiaomi settings with generic model and speaker voice aliases", () => {
    const config = resolveConfig({
      xiaomi: {
        baseUrl: "https://example.com/v1/",
        modelId: "mimo-v2.5-tts-voicedesign",
        speakerVoice: "Chloe",
        format: "wav",
        style: "Bright and fast.",
      },
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
    expect(resolveConfig({ mimo: { voiceId: "default_zh" } }).voice).toBe("default_zh");
  });

  const policy = createSpeechDirectivePolicy();
  const parse = (key: string, value: string) =>
    provider.parseDirectiveToken!({ key, value, policy });
  const expectOverride = (key: string, value: string) =>
    expect(parse(key, value)).toEqual({ handled: true, overrides: { [key]: value } });

  it("handles voice, model, style, and format tokens", () => {
    expectOverride("voice", "default_en");
    expectOverride("model", "mimo-v2.5-tts");
    expectOverride("style", "whispered");
    expectOverride("format", "wav");
  });

  it("warns on invalid format", () => {
    expect(parse("format", "ogg")).toMatchObject({ handled: true, warnings: [expect.any(String)] });
  });

  describe("synthesize", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
      transcodeMock.mockReset();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it.each(["audio-file", "voice-note"] as const)("synthesizes %s", async (target) => {
      const voiceNote = target === "voice-note";
      mockAudioResponse(voiceNote ? "fake-wav-audio" : "fake-mp3-audio");
      if (voiceNote) {
        transcodeMock.mockResolvedValueOnce(Buffer.from("fake-opus-audio"));
      }
      const mockFetch = vi.mocked(globalThis.fetch);
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const result = await synthesize({
        target,
        timeoutMs: voiceNote ? 30000 : MAX_TIMER_TIMEOUT_MS + 1_000_000,
        providerConfig: voiceNote
          ? { apiKey: "sk-test", model: "mimo-v2.5-tts-voicedesign", format: "wav" }
          : { apiKey: "sk-test", model: "mimo-v2.5-tts", voice: "default_en", style: "Bright." },
      });
      const outputFormat = voiceNote ? "opus" : "mp3";
      expect(result).toEqual({
        outputFormat,
        fileExtension: `.${outputFormat}`,
        voiceCompatible: voiceNote,
        audioBuffer: Buffer.from(voiceNote ? "fake-opus-audio" : "fake-mp3-audio"),
      });
      expect(
        timeoutSpy.mock.calls.some(
          ([, delay]) => delay === (voiceNote ? 30000 : MAX_TIMER_TIMEOUT_MS),
        ),
      ).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] ?? [];
      expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
      expect(init?.headers).toEqual({
        "api-key": "sk-test",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(init!.body as string)).toEqual({
        model: voiceNote ? "mimo-v2.5-tts-voicedesign" : "mimo-v2.5-tts",
        messages: [
          { role: "user", content: voiceNote ? expect.stringContaining("natural") : "Bright." },
          { role: "assistant", content: "Hello from OpenClaw." },
        ],
        audio: voiceNote ? { format: "wav" } : { format: "mp3", voice: "default_en" },
      });
      if (voiceNote) {
        expect(transcodeMock).toHaveBeenCalledWith({
          audioBuffer: Buffer.from("fake-wav-audio"),
          inputExtension: "wav",
          tempPrefix: "tts-xiaomi-",
          timeoutMs: 30000,
        });
      } else {
        expect(transcodeMock).not.toHaveBeenCalled();
      }
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
      expect(new Headers(requestInit()?.headers).get("api-key")).toBe("fake");
    });

    it.each([
      ["missing", "Xiaomi TTS API returned no audio data"],
      ["malformed", "Xiaomi TTS API returned malformed base64 audio data"],
      ["oversized", "Xiaomi TTS API: JSON response exceeds 16777216 bytes"],
    ])("rejects %s audio", async (kind, error) => {
      if (kind === "oversized") {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeOversizedStreamResponse());
      } else {
        mockResponse(kind === "malformed" ? "ZE==" : undefined);
      }
      await expect(synthesize()).rejects.toThrow(error);
    });
  });
});
