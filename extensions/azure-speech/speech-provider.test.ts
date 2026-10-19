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

type Config = Record<string, unknown>;

describe("buildAzureSpeechProvider", () => {
  const provider = buildAzureSpeechProvider();
  const synthesisRequest = {
    text: "hello",
    cfg: {},
    providerConfig: { apiKey: "key", region: "eastus", voice: "en-US-JennyNeural" },
    timeoutMs: 30_000,
  };
  const context = { cfg: {}, timeoutMs: 30_000 };
  const resolveConfig = (providers: Config) =>
    provider.resolveConfig!({ ...context, rawConfig: { providers } });
  const resolveTalk = (base: Config, talkProviderConfig: Config) =>
    provider.resolveTalkConfig!({
      ...context,
      baseTtsConfig: { providers: { "azure-speech": base } },
      talkProviderConfig,
    });
  const isConfigured = (providerConfig: Config) =>
    provider.isConfiguredAsync!({ ...context, providerConfig });
  const customUrl = "https://speech.example.com/custom";
  const talkUrl = "https://talk.example.com/speech";
  const customBase = { baseUrl: customUrl };
  const talkEndpoint = { endpoint: `${talkUrl}/cognitiveservices/v1/` };
  const westusUrl = "https://westus.tts.speech.microsoft.com";
  const voiceOverrides = { voice: "en-US-AriaNeural", lang: "en-US" };
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
  function expectAudio(result: unknown, lang: string, outputFormat: string, metadata: Config) {
    expect(azureSpeechTTSMock).toHaveBeenCalledWith({ ...expectedTtsRequest, lang, outputFormat });
    expect(result).toEqual({ audioBuffer: Buffer.from("audio-bytes"), outputFormat, ...metadata });
  }
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

  it("reports configured only when key plus region or endpoint is available", async () => {
    expect(await isConfigured({})).toBe(false);
    expect(await isConfigured({ apiKey: "key" })).toBe(false);
    expect(await isConfigured({ apiKey: "key", region: "eastus" })).toBe(true);
    vi.stubEnv("AZURE_SPEECH_KEY", "env-key");
    vi.stubEnv("AZURE_SPEECH_REGION", "eastus");
    expect(await isConfigured({})).toBe(true);
  });

  it("normalizes provider-owned config under canonical and alias keys", () => {
    const canonical = resolveConfig({
      "azure-speech": {
        apiKey: "key",
        region: "eastus",
        ...voiceOverrides,
      },
    });
    const alias = resolveConfig({
      azure: {
        apiKey: "alias-key",
        endpoint: "https://westus.tts.speech.microsoft.com/cognitiveservices/v1/",
      },
    });
    const defaults = {
      lang: "en-US",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      voiceNoteOutputFormat: "ogg-24khz-16bit-mono-opus",
      timeoutMs: undefined,
    };
    expect(canonical).toEqual({
      ...defaults,
      apiKey: "key",
      region: "eastus",
      endpoint: undefined,
      baseUrl: "https://eastus.tts.speech.microsoft.com",
      voice: "en-US-AriaNeural",
    });
    expect(alias).toEqual({
      ...defaults,
      apiKey: "alias-key",
      region: undefined,
      endpoint: "https://westus.tts.speech.microsoft.com/cognitiveservices/v1/",
      baseUrl: "https://westus.tts.speech.microsoft.com",
      voice: "en-US-JennyNeural",
    });
  });

  it("preserves inherited Talk settings when overrides are blank", () => {
    const params = { voiceId: " ", languageCode: " fr-FR ", outputFormat: " " };
    const talk = resolveTalk(
      { apiKey: "base-key", voice: "base-voice" },
      { ...params, apiKey: " " },
    );
    expect(talk).toMatchObject({ apiKey: "base-key", voice: "base-voice", lang: "fr-FR" });
    expect(provider.resolveTalkOverrides?.({ talkProviderConfig: {}, params })).toStrictEqual({
      lang: "fr-FR",
    });
  });

  it.each([
    ["endpoint without region", { region: undefined, endpoint: customUrl }, {}, customUrl],
    ["inherited region", {}, {}, "https://eastus.tts.speech.microsoft.com"],
    ["inherited endpoint", { endpoint: `${customUrl}/cognitiveservices/v1` }, {}, customUrl],
    ["inherited base URL", { baseUrl: `${customUrl}/` }, {}, customUrl],
    ["voice-only override", customBase, { voiceId: "en-US-AriaNeural" }, customUrl],
    ["explicit Talk endpoint", customBase, talkEndpoint, talkUrl],
    ["explicit Talk base URL", customBase, { baseUrl: `${talkUrl}/` }, talkUrl],
    ["explicit Talk region", customBase, { region: "westus" }, westusUrl],
  ] as const)("routes synthesis with %s", async (_name, base, talk, expected) => {
    const resolved = resolveTalk({ apiKey: "key", region: "eastus", ...base }, talk);
    const providerConfig = resolveConfig({ "azure-speech": resolved });
    await provider.synthesize({ ...synthesisRequest, providerConfig, target: "audio-file" });
    expect(azureSpeechTTSMock).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: expected }));
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

    const parse = (key: string, value: string) =>
      provider.parseDirectiveToken?.({ key, value, policy });
    expect(parse("azure_voice", "v")).toEqual({ handled: true, overrides: { voice: "v" } });
    expect(parse("azure_lang", "en-US")).toEqual({ handled: true, overrides: { lang: "en-US" } });
    expect(parse("azure_output_format", "ogg")).toEqual({
      handled: true,
      overrides: { outputFormat: "ogg" },
    });
  });

  it("uses native Ogg/Opus for voice-note output", async () => {
    const result = await provider.synthesize({
      ...synthesisRequest,
      providerOverrides: voiceOverrides,
      target: "voice-note",
    });

    expectAudio(result, "en-US", "ogg-24khz-16bit-mono-opus", {
      fileExtension: ".ogg",
      voiceCompatible: true,
    });
  });

  it("honors voice and language overrides for telephony output", async () => {
    const result = await provider.synthesizeTelephony?.({
      ...synthesisRequest,
      providerConfig: { ...synthesisRequest.providerConfig, lang: "en-US" },
      providerOverrides: { ...voiceOverrides, lang: "es-US" },
    });

    expectAudio(result, "es-US", "raw-8khz-8bit-mono-mulaw", { sampleRate: 8_000 });
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

    expect(await provider.isConfiguredAsync?.({ providerConfig, timeoutMs: 1_000 })).toBe(false);
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
