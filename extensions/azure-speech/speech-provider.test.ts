import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { azureSpeechTTSMock, listAzureSpeechVoicesMock, resolveGeneratedMediaMaxBytesMock } =
  vi.hoisted(() => ({
    azureSpeechTTSMock: vi.fn(async () => Buffer.from("audio-bytes")),
    listAzureSpeechVoicesMock: vi.fn(async () => [{ id: "en-US-JennyNeural", name: "Jenny" }]),
    resolveGeneratedMediaMaxBytesMock:
      vi.fn<
        typeof import("openclaw/plugin-sdk/media-generation-runtime").resolveGeneratedMediaMaxBytes
      >(),
  }));

// The SDK facade imports host worker declarations that trigger unrelated test-worker compilation.
vi.mock("openclaw/plugin-sdk/media-generation-runtime", () => ({
  resolveGeneratedMediaMaxBytes: resolveGeneratedMediaMaxBytesMock,
}));

vi.mock("./tts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tts.js")>();
  return {
    ...actual,
    azureSpeechTTS: azureSpeechTTSMock,
    listAzureSpeechVoices: listAzureSpeechVoicesMock,
  };
});

import { buildAzureSpeechProvider } from "./speech-provider.js";

describe("buildAzureSpeechProvider", () => {
  const provider = buildAzureSpeechProvider();
  const synthesisRequest = {
    text: "hello",
    cfg: {},
    providerConfig: { apiKey: "key", region: "eastus", voice: "en-US-JennyNeural" },
    timeoutMs: 30_000,
  };
  const expectedTtsRequest = {
    text: "hello",
    apiKey: "key",
    baseUrl: "https://eastus.tts.speech.microsoft.com",
    endpoint: undefined,
    region: "eastus",
    voice: "en-US-AriaNeural",
    timeoutMs: 30_000,
    maxBytes: 16 * 1024 * 1024,
  };
  const envKeys = [
    "AZURE_SPEECH_KEY",
    "AZURE_SPEECH_API_KEY",
    "AZURE_SPEECH_REGION",
    "AZURE_SPEECH_ENDPOINT",
    "SPEECH_KEY",
    "SPEECH_REGION",
  ] as const;

  beforeEach(() => {
    resolveGeneratedMediaMaxBytesMock.mockReset().mockReturnValue(16 * 1024 * 1024);
    for (const key of envKeys) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    azureSpeechTTSMock.mockClear();
    listAzureSpeechVoicesMock.mockClear();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./tts.js");
    vi.doUnmock("openclaw/plugin-sdk/media-generation-runtime");
    vi.resetModules();
  });

  it("reports configured only when key plus region or endpoint is available", () => {
    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30_000 })).toBe(false);
    expect(provider.isConfigured({ providerConfig: { apiKey: "key" }, timeoutMs: 30_000 })).toBe(
      false,
    );
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "key", region: "eastus" },
        timeoutMs: 30_000,
      }),
    ).toBe(true);

    vi.stubEnv("AZURE_SPEECH_KEY", "env-key");
    vi.stubEnv("AZURE_SPEECH_REGION", "eastus");
    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30_000 })).toBe(true);
  });

  it("normalizes provider-owned config under canonical and alias keys", () => {
    const canonical = provider.resolveConfig?.({
      cfg: {},
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          "azure-speech": {
            apiKey: "key",
            region: "eastus",
            voice: "en-US-AriaNeural",
            lang: "en-US",
          },
        },
      },
    });
    const alias = provider.resolveConfig?.({
      cfg: {},
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          azure: {
            apiKey: "alias-key",
            endpoint: "https://westus.tts.speech.microsoft.com/cognitiveservices/v1/",
          },
        },
      },
    });

    expect(canonical).toEqual({
      apiKey: "key",
      region: "eastus",
      endpoint: undefined,
      baseUrl: "https://eastus.tts.speech.microsoft.com",
      voice: "en-US-AriaNeural",
      lang: "en-US",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      voiceNoteOutputFormat: "ogg-24khz-16bit-mono-opus",
      timeoutMs: undefined,
    });
    expect(alias).toEqual({
      apiKey: "alias-key",
      region: undefined,
      endpoint: "https://westus.tts.speech.microsoft.com/cognitiveservices/v1/",
      baseUrl: "https://westus.tts.speech.microsoft.com",
      voice: "en-US-JennyNeural",
      lang: "en-US",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      voiceNoteOutputFormat: "ogg-24khz-16bit-mono-opus",
      timeoutMs: undefined,
    });
  });

  it("preserves inherited Talk settings when overrides are blank", () => {
    const params = { voiceId: " ", languageCode: " fr-FR ", outputFormat: " " };
    const talk = provider.resolveTalkConfig?.({
      cfg: {},
      baseTtsConfig: { providers: { "azure-speech": { apiKey: "base-key", voice: "base-voice" } } },
      talkProviderConfig: { ...params, apiKey: " " },
      timeoutMs: 1000,
    });
    expect(talk).toMatchObject({ apiKey: "base-key", voice: "base-voice", lang: "fr-FR" });
    expect(provider.resolveTalkOverrides?.({ talkProviderConfig: {}, params })).toStrictEqual({
      lang: "fr-FR",
    });
  });

  it("parses provider-specific TTS directives", () => {
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

    expect(provider.parseDirectiveToken?.({ key: "azure_voice", value: "v", policy })).toEqual({
      handled: true,
      overrides: { voice: "v" },
    });
    expect(provider.parseDirectiveToken?.({ key: "azure_lang", value: "en-US", policy })).toEqual({
      handled: true,
      overrides: { lang: "en-US" },
    });
    expect(
      provider.parseDirectiveToken?.({ key: "azure_output_format", value: "ogg", policy }),
    ).toEqual({
      handled: true,
      overrides: { outputFormat: "ogg" },
    });
  });

  it("uses native Ogg/Opus for voice-note output", async () => {
    const result = await provider.synthesize({
      ...synthesisRequest,
      providerOverrides: {
        voice: "en-US-AriaNeural",
        lang: "en-US",
      },
      target: "voice-note",
    });

    expect(azureSpeechTTSMock).toHaveBeenCalledWith({
      ...expectedTtsRequest,
      lang: "en-US",
      outputFormat: "ogg-24khz-16bit-mono-opus",
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("audio-bytes"),
      outputFormat: "ogg-24khz-16bit-mono-opus",
      fileExtension: ".ogg",
      voiceCompatible: true,
    });
  });

  it("honors voice and language overrides for telephony output", async () => {
    const result = await provider.synthesizeTelephony?.({
      ...synthesisRequest,
      providerConfig: { ...synthesisRequest.providerConfig, lang: "en-US" },
      providerOverrides: {
        voice: "en-US-AriaNeural",
        lang: "es-US",
      },
    });

    expect(azureSpeechTTSMock).toHaveBeenCalledWith({
      ...expectedTtsRequest,
      lang: "es-US",
      outputFormat: "raw-8khz-8bit-mono-mulaw",
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("audio-bytes"),
      outputFormat: "raw-8khz-8bit-mono-mulaw",
      sampleRate: 8_000,
    });
  });

  it("forwards the configured media byte cap to synthesis requests", async () => {
    const cfg = {
      agents: {
        defaults: {
          mediaMaxMb: 2,
        },
      },
    };
    resolveGeneratedMediaMaxBytesMock.mockReturnValue(2 * 1024 * 1024);

    await provider.synthesize({
      ...synthesisRequest,
      cfg,
      target: "audio-file",
    });

    expect(resolveGeneratedMediaMaxBytesMock).toHaveBeenCalledExactlyOnceWith(cfg, "audio");
    expect(azureSpeechTTSMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytes: 2 * 1024 * 1024,
      }),
    );
  });

  it("lists voices through config or explicit request auth", async () => {
    const voices = await provider.listVoices?.({
      providerConfig: { apiKey: "key", region: "eastus", timeoutMs: 45_000 },
      timeoutMs: 30_000,
    });

    expect(voices).toEqual([{ id: "en-US-JennyNeural", name: "Jenny" }]);
    expect(listAzureSpeechVoicesMock).toHaveBeenCalledWith({
      apiKey: "key",
      baseUrl: "https://eastus.tts.speech.microsoft.com",
      endpoint: undefined,
      region: "eastus",
      timeoutMs: 45_000,
    });
  });

  it("rejects blank credentials across readiness, discovery, and synthesis", async () => {
    vi.stubEnv("AZURE_SPEECH_KEY", "   ");
    vi.stubEnv("AZURE_SPEECH_API_KEY", "   ");
    vi.stubEnv("SPEECH_KEY", "   ");
    const providerConfig = { apiKey: "   ", region: "eastus" };

    expect(provider.isConfigured({ providerConfig, timeoutMs: 1_000 })).toBe(false);
    await expect(
      provider.listVoices?.({ apiKey: "   ", providerConfig, timeoutMs: 1_000 }),
    ).rejects.toThrow("Azure Speech API key missing");

    const request = {
      ...synthesisRequest,
      providerConfig,
      target: "audio-file" as const,
      timeoutMs: 1_000,
    };
    await expect(provider.synthesize(request)).rejects.toThrow("Azure Speech API key missing");
    await expect(provider.synthesizeTelephony?.(request)).rejects.toThrow(
      "Azure Speech API key missing",
    );

    expect(listAzureSpeechVoicesMock).not.toHaveBeenCalled();
    expect(azureSpeechTTSMock).not.toHaveBeenCalled();
  });
});
