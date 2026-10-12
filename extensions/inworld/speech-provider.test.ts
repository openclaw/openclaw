import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { inworldTTSMock, listInworldVoicesMock } = vi.hoisted(() => ({
  inworldTTSMock: vi.fn(),
  listInworldVoicesMock: vi.fn(),
}));

vi.mock("./tts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tts.js")>();
  return {
    ...actual,
    inworldTTS: inworldTTSMock,
    listInworldVoices: listInworldVoicesMock,
  };
});

import { buildInworldSpeechProvider } from "./speech-provider.js";

const request = {
  text: "Hello",
  cfg: {},
  providerConfig: { apiKey: "key", voiceId: "Sarah", modelId: "inworld-tts-1.5-max" },
  timeoutMs: 30_000,
};
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

afterAll(() => {
  vi.doUnmock("./tts.js");
  vi.resetModules();
});

describe("buildInworldSpeechProvider", () => {
  const provider = buildInworldSpeechProvider();

  afterEach(() => {
    inworldTTSMock.mockReset();
    listInworldVoicesMock.mockReset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects blank API keys across every request entrypoint", async () => {
    vi.stubEnv("INWORLD_API_KEY", "   ");
    const blankRequest = { ...request, providerConfig: {}, timeoutMs: 5_000 };

    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "   " },
        timeoutMs: 30_000,
      }),
    ).toBe(false);

    await expect(provider.listVoices?.({ ...blankRequest, apiKey: "   " })).rejects.toThrow(
      "Inworld API key missing",
    );
    await expect(provider.synthesize({ ...blankRequest, target: "audio-file" })).rejects.toThrow(
      "Inworld API key missing",
    );
    await expect(provider.synthesizeTelephony?.(blankRequest)).rejects.toThrow(
      "Inworld API key missing",
    );

    expect(listInworldVoicesMock).not.toHaveBeenCalled();
    expect(inworldTTSMock).not.toHaveBeenCalled();
  });

  it("forwards the core-resolved voice-list timeout", async () => {
    await provider.listVoices?.({
      providerConfig: { apiKey: "test-key" },
      timeoutMs: 30_000,
    });

    expect(listInworldVoicesMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-key", timeoutMs: 30_000 }),
    );
  });

  it("normalizes provider-owned speech config from raw provider config", () => {
    const resolved = provider.resolveConfig?.({
      cfg: {},
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          inworld: {
            apiKey: "basic-key",
            baseUrl: "https://custom.inworld.example.com/",
            voiceId: "Ashley",
            modelId: "inworld-tts-1.5-mini",
            temperature: 0.8,
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "basic-key",
      baseUrl: "https://custom.inworld.example.com",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.8,
    });
  });

  it("preserves inherited Talk settings when overrides are blank", () => {
    const params = { voiceId: " ", modelId: " inworld-tts-1.5-mini ", temperature: 0.5 };
    const talk = provider.resolveTalkConfig?.({
      cfg: {},
      baseTtsConfig: { providers: { inworld: { apiKey: "base-key", voiceId: "Ashley" } } },
      talkProviderConfig: { ...params, apiKey: " ", baseUrl: " " },
      timeoutMs: 1000,
    });
    expect(talk).toMatchObject({
      apiKey: "base-key",
      baseUrl: "https://api.inworld.ai",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.5,
    });
    expect(provider.resolveTalkOverrides?.({ talkProviderConfig: {}, params })).toStrictEqual({
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.5,
    });
  });

  it("parses Inworld TTS directive overrides", () => {
    expect(provider.parseDirectiveToken?.({ key: "voice", value: "Ashley", policy })).toEqual({
      handled: true,
      overrides: { voiceId: "Ashley" },
    });
    expect(
      provider.parseDirectiveToken?.({
        key: "model",
        value: "inworld-tts-1.5-mini",
        policy,
      }),
    ).toEqual({
      handled: true,
      overrides: { modelId: "inworld-tts-1.5-mini" },
    });
    expect(provider.parseDirectiveToken?.({ key: "temperature", value: "0.7", policy })).toEqual({
      handled: true,
      overrides: { temperature: 0.7 },
    });
  });

  it.each(["3"])("warns on invalid directive temperature %s", (value) => {
    expect(
      provider.parseDirectiveToken?.({
        key: "temperature",
        value,
        policy,
      }),
    ).toEqual({
      handled: true,
      warnings: [`invalid Inworld temperature "${value}"`],
    });
  });

  it("drops malformed temperature values before synthesis", async () => {
    inworldTTSMock.mockResolvedValueOnce(Buffer.from("audio"));

    await provider.synthesize({
      ...request,
      providerConfig: { ...request.providerConfig, temperature: 0 },
      providerOverrides: { temperature: 3 },
      target: "audio-file",
    });

    expect(inworldTTSMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ temperature: expect.any(Number) }),
    );
  });

  it("synthesizes voice-note targets with native OGG_OPUS output", async () => {
    inworldTTSMock.mockResolvedValueOnce(Buffer.from("opus"));

    const result = await provider.synthesize({
      ...request,
      providerOverrides: { voice: "Ashley", model: "inworld-tts-1.5-mini", temperature: 0.6 },
      target: "voice-note",
    });

    expect(inworldTTSMock).toHaveBeenCalledWith({
      text: "Hello",
      apiKey: "key",
      baseUrl: "https://api.inworld.ai",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      audioEncoding: "OGG_OPUS",
      temperature: 0.6,
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("opus"),
      outputFormat: "ogg_opus",
      fileExtension: ".ogg",
      voiceCompatible: true,
    });
  });

  it("synthesizes telephony PCM at 22050 Hz", async () => {
    inworldTTSMock.mockResolvedValueOnce(Buffer.from("pcm"));

    const result = await provider.synthesizeTelephony?.({
      ...request,
      providerOverrides: { voice: "Ashley", model: "inworld-tts-1.5-mini", temperature: 0.6 },
    });

    expect(inworldTTSMock).toHaveBeenCalledWith({
      text: "Hello",
      apiKey: "key",
      baseUrl: "https://api.inworld.ai",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      audioEncoding: "PCM",
      sampleRateHertz: 22_050,
      temperature: 0.6,
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("pcm"),
      outputFormat: "pcm",
      sampleRate: 22_050,
    });
  });
});
