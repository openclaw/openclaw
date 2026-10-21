import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildXaiSpeechProvider } from "./speech-provider.js";
import type { xaiTTS, xaiTTSStream } from "./tts.js";

const provider = buildXaiSpeechProvider();

const mocks = vi.hoisted(() => ({
  tts: vi.fn<typeof xaiTTS>(async () => Buffer.from("audio-bytes")),
  voices: vi.fn(async () => [{ id: "altair", name: "Altair" }]),
  stream: vi.fn<typeof xaiTTSStream>(async () => ({
    audioStream: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    release: vi.fn(async () => {}),
  })),
  configured: vi.fn(async () => false),
  resolveKey: vi.fn(async (): Promise<{ apiKey: string | undefined }> => ({ apiKey: undefined })),
}));
// mock-isolation: Provider request tests replace network synthesis and voice discovery with fixtures.
vi.mock("./tts.js", () => ({
  listXaiTtsVoices: mocks.voices,
  xaiTTS: mocks.tts,
  xaiTTSStream: mocks.stream,
}));
// mock-isolation: Requests supply credential availability independently of host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: () => false,
  isProviderAuthProfileConfiguredAsync: mocks.configured,
}));
// mock-isolation: OAuth fallback responses are fixtures and must not read host credentials.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: mocks.resolveKey,
}));

function request(overrides: Partial<SpeechSynthesisRequest> = {}): SpeechSynthesisRequest {
  return {
    text: "hello",
    cfg: {},
    providerConfig: { apiKey: "xai-key" },
    target: "audio-file",
    timeoutMs: 5_000,
    ...overrides,
  };
}
function requireLastTtsCall() {
  const params = mocks.tts.mock.calls.at(-1)?.[0];
  if (!params) {
    throw new Error("Expected xaiTTS call");
  }
  return params;
}

describe("xai speech provider", () => {
  afterEach(() => {
    mocks.tts.mockClear();
    mocks.stream.mockClear();
    mocks.configured.mockReset().mockResolvedValue(false);
    mocks.resolveKey.mockReset().mockResolvedValue({ apiKey: undefined });
    mocks.voices.mockReset().mockResolvedValue([{ id: "altair", name: "Altair" }]);
    delete process.env.XAI_API_KEY;
    delete process.env.XAI_BASE_URL;
  });

  it("streams alaw when requested by a compatible caller", async () => {
    const result = await provider.streamSynthesize?.(
      request({ providerConfig: { apiKey: "xai-key", responseFormat: "alaw" } }),
    );
    expect(result?.outputFormat).toBe("alaw");
    expect(mocks.stream.mock.calls.at(-1)?.[0]?.responseFormat).toBe("alaw");
    await result?.release?.();
  });

  it("honors voice, language, and speed overrides for telephony output", async () => {
    const result = await provider.synthesizeTelephony?.(
      request({
        providerConfig: {
          apiKey: "xai-key",
          baseUrl: "https://api.x.ai/v1",
          voiceId: "eve",
          language: "en",
          speed: 1,
        },
        providerOverrides: { voice: "aura", language: "es", speed: 1.2 },
      }),
    );
    expect(result).toEqual({
      audioBuffer: Buffer.from("audio-bytes"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    });
    expect(requireLastTtsCall()).toMatchObject({
      voiceId: "aura",
      language: "es",
      speed: 1.2,
      responseFormat: "pcm",
    });
  });

  it("drops malformed speed values before synthesis", async () => {
    await provider.synthesize(
      request({
        providerConfig: { apiKey: "xai-key", speed: 2 },
        providerOverrides: { speed: 0.5 },
      }),
    );
    expect(requireLastTtsCall().speed).toBeUndefined();
  });

  it("treats blank direct credentials as absent across readiness and requests", async () => {
    process.env.XAI_API_KEY = "   ";
    const providerConfig = { apiKey: "   " };
    expect(await provider.isConfiguredAsync?.({ cfg: {}, providerConfig, timeoutMs: 5_000 })).toBe(
      false,
    );
    await expect(provider.listVoices?.({ apiKey: "   ", providerConfig })).resolves.toEqual(
      ["ara", "eve", "leo", "rex", "sal"].map((voice) => ({ id: voice, name: voice })),
    );
    await expect(provider.synthesize(request({ providerConfig }))).rejects.toThrow(
      "xAI credentials missing for TTS",
    );
    expect(mocks.voices).not.toHaveBeenCalled();
    expect(mocks.tts).not.toHaveBeenCalled();
  });

  it("uses cfg-scoped profile auth for voice discovery", async () => {
    mocks.resolveKey.mockResolvedValue({ apiKey: "oauth-bearer" });
    const cfg = { agents: { defaults: {} } };
    await provider.listVoices?.({ providerConfig: {}, cfg });
    expect(mocks.resolveKey).toHaveBeenCalledWith({ provider: "xai", cfg });
    expect(mocks.voices).toHaveBeenCalledWith({
      apiKey: "oauth-bearer",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("threads cfg into the OAuth fallback resolver when no direct apiKey is available", async () => {
    mocks.resolveKey.mockResolvedValueOnce({ apiKey: "oauth-bearer" });
    const cfg = { agents: { defaults: {} } };
    await provider.synthesize(request({ cfg, providerConfig: {}, target: "voice-note" }));
    expect(mocks.resolveKey).toHaveBeenCalledWith({ provider: "xai", cfg });
    expect(requireLastTtsCall().apiKey).toBe("oauth-bearer");
  });
});
