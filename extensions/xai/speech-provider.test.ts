// Xai tests cover speech provider plugin behavior.
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildXaiSpeechProvider } from "./speech-provider.js";
import type { xaiTTS, xaiTTSStream } from "./tts.js";

const {
  xaiTTSMock,
  listXaiTtsVoicesMock,
  xaiTTSStreamMock,
  isProviderAuthProfileConfiguredAsyncMock,
  resolveApiKeyForProviderMock,
} = vi.hoisted(() => ({
  xaiTTSMock: vi.fn<typeof xaiTTS>(async () => Buffer.from("audio-bytes")),
  listXaiTtsVoicesMock: vi.fn(async () => [{ id: "altair", name: "Altair" }]),
  xaiTTSStreamMock: vi.fn<typeof xaiTTSStream>(async () => ({
    audioStream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
    release: vi.fn(async () => {}),
  })),
  isProviderAuthProfileConfiguredAsyncMock: vi.fn(async () => false),
  resolveApiKeyForProviderMock: vi.fn(async (): Promise<{ apiKey: string | undefined }> => ({
    apiKey: undefined,
  })),
}));

vi.mock("./tts.js", () => ({
  listXaiTtsVoices: listXaiTtsVoicesMock,
  xaiTTS: xaiTTSMock,
  xaiTTSStream: xaiTTSStreamMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: () => false,
  isProviderAuthProfileConfiguredAsync: isProviderAuthProfileConfiguredAsyncMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

function requireLastTtsCall() {
  const params = xaiTTSMock.mock.calls.at(-1)?.[0];
  if (!params) {
    throw new Error("Expected xaiTTS call");
  }
  return params;
}

describe("xai speech provider", () => {
  afterEach(() => {
    xaiTTSMock.mockClear();
    xaiTTSStreamMock.mockClear();
    isProviderAuthProfileConfiguredAsyncMock.mockReset();
    isProviderAuthProfileConfiguredAsyncMock.mockResolvedValue(false);
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    listXaiTtsVoicesMock.mockReset();
    listXaiTtsVoicesMock.mockResolvedValue([{ id: "altair", name: "Altair" }]);
    delete process.env.XAI_API_KEY;
    delete process.env.XAI_BASE_URL;
  });

  it.each(["alaw"] as const)(
    "streams %s when requested by a compatible caller",
    async (responseFormat) => {
      const provider = buildXaiSpeechProvider();

      const result = await provider.streamSynthesize?.({
        text: "hello",
        cfg: {},
        providerConfig: {
          apiKey: "xai-key",
          responseFormat,
        },
        target: "audio-file",
        timeoutMs: 5_000,
      });
      expect(result?.outputFormat).toBe(responseFormat);
      const streamParams = xaiTTSStreamMock.mock.calls.at(-1)?.[0];
      expect(streamParams?.responseFormat).toBe(responseFormat);
      await result?.release?.();
    },
  );

  it("honors voice, language, and speed overrides for telephony output", async () => {
    const provider = buildXaiSpeechProvider();
    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {},
      providerConfig: {
        apiKey: "xai-key",
        baseUrl: "https://api.x.ai/v1",
        voiceId: "eve",
        language: "en",
        speed: 1,
      },
      providerOverrides: {
        voice: "aura",
        language: "es",
        speed: 1.2,
      },
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      audioBuffer: Buffer.from("audio-bytes"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    });
    const tts = requireLastTtsCall();
    expect(tts.voiceId).toBe("aura");
    expect(tts.language).toBe("es");
    expect(tts.speed).toBe(1.2);
    expect(tts.responseFormat).toBe("pcm");
  });

  it("drops malformed speed values before synthesis", async () => {
    const provider = buildXaiSpeechProvider();
    await provider.synthesize({
      text: "hello",
      cfg: {},
      providerConfig: {
        apiKey: "xai-key",
        speed: 2,
      },
      providerOverrides: {
        speed: 0.5,
      },
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(requireLastTtsCall().speed).toBeUndefined();
  });

  it("treats blank direct credentials as absent across readiness and requests", async () => {
    process.env.XAI_API_KEY = "   ";
    const provider = buildXaiSpeechProvider();
    const providerConfig = { apiKey: "   " };

    expect(await provider.isConfiguredAsync?.({ cfg: {}, providerConfig, timeoutMs: 5_000 })).toBe(
      false,
    );
    await expect(provider.listVoices?.({ apiKey: "   ", providerConfig })).resolves.toEqual(
      ["ara", "eve", "leo", "rex", "sal"].map((voice) => ({ id: voice, name: voice })),
    );
    await expect(
      provider.synthesize({
        text: "hello",
        cfg: {},
        providerConfig,
        target: "audio-file",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("xAI credentials missing for TTS");

    expect(listXaiTtsVoicesMock).not.toHaveBeenCalled();
    expect(xaiTTSMock).not.toHaveBeenCalled();
  });

  it("uses cfg-scoped profile auth for voice discovery", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "oauth-bearer" });
    const provider = buildXaiSpeechProvider();
    const cfg = { agents: { defaults: {} } };

    await provider.listVoices?.({ providerConfig: {}, cfg });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({ provider: "xai", cfg });
    expect(listXaiTtsVoicesMock).toHaveBeenCalledWith({
      apiKey: "oauth-bearer",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("threads cfg into the OAuth fallback resolver when no direct apiKey is available", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "oauth-bearer" });
    const provider = buildXaiSpeechProvider();
    const cfg = { agents: { defaults: {} } };
    await provider.synthesize({
      text: "hello",
      cfg,
      providerConfig: {},
      target: "voice-note",
      timeoutMs: 5_000,
    });
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({ provider: "xai", cfg });
    expect(requireLastTtsCall().apiKey).toBe("oauth-bearer");
  });
});
