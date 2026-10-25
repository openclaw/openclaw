import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";

const { resolveGeneratedMediaMaxBytesMock } = vi.hoisted(() => ({
  resolveGeneratedMediaMaxBytesMock:
    vi.fn<
      typeof import("openclaw/plugin-sdk/media-generation-runtime").resolveGeneratedMediaMaxBytes
    >(),
}));

// The SDK facade imports host worker declarations that trigger unrelated test-worker compilation.
vi.mock("openclaw/plugin-sdk/media-generation-runtime", () => ({
  resolveGeneratedMediaMaxBytes: resolveGeneratedMediaMaxBytesMock,
}));

import { buildAzureSpeechProvider } from "./speech-provider.js";

type Config = Record<string, unknown>;

describe("buildAzureSpeechProvider", () => {
  installPinnedHostnameTestHooks();
  const fetchMock = vi.fn<typeof fetch>();
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
  function expectAudio(result: unknown, lang: string, outputFormat: string, metadata: Config) {
    expect(fetchMock).toHaveBeenCalledWith(
      "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Ocp-Apim-Subscription-Key": "key",
          "X-Microsoft-OutputFormat": outputFormat,
        }),
        body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="en-US-AriaNeural">hello</voice></speak>`,
      }),
    );
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
    fetchMock
      .mockReset()
      .mockImplementation(
        async () =>
          new Response(Buffer.from("audio-bytes"), { headers: { "Content-Type": "audio/mpeg" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    resolveGeneratedMediaMaxBytesMock.mockReset().mockReturnValue(16 * 1024 * 1024);
    for (const key of envKeys) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
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
    expect(fetchMock).toHaveBeenCalledWith(
      `${expected}/cognitiveservices/v1`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    {
      config: { region: "westus" },
      environment: "AZURE_SPEECH_REGION",
      value: "eastus",
      expected: westusUrl,
    },
    {
      config: { endpoint: customUrl },
      environment: "AZURE_SPEECH_REGION",
      value: "eastus",
      expected: customUrl,
    },
    {
      config: { region: "westus" },
      environment: "AZURE_SPEECH_ENDPOINT",
      value: customUrl,
      expected: westusUrl,
    },
  ])(
    "prefers explicit $config routing over $environment",
    async ({ config, environment, value, expected }) => {
      vi.stubEnv(environment, value);
      const providerConfig = { apiKey: "key", ...config };
      await provider.synthesize({ ...synthesisRequest, providerConfig, target: "audio-file" });
      fetchMock.mockResolvedValueOnce(Response.json([]));
      await provider.listVoices?.({ providerConfig, timeoutMs: 30_000 });

      expect(
        fetchMock.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString())),
      ).toEqual([`${expected}/cognitiveservices/v1`, `${expected}/cognitiveservices/voices/list`]);
    },
  );

  it("parses provider-specific TTS directives", () => {
    const policy = createSpeechDirectivePolicy();

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
    fetchMock.mockResolvedValueOnce(
      Response.json([{ ShortName: "en-US-JennyNeural", DisplayName: "Jenny" }]),
    );
    const guardedFetch = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard");
    const voices = await provider.listVoices?.({
      providerConfig: { apiKey: "key", region: "eastus", timeoutMs: 45_000 },
      timeoutMs: 30_000,
    });

    expect(voices).toEqual([{ id: "en-US-JennyNeural", name: "Jenny" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list",
      expect.objectContaining({ headers: { "Ocp-Apim-Subscription-Key": "key" } }),
    );
    expect(guardedFetch).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45_000 }));
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

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
