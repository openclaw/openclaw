import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";

const { inworldTTSMock, listInworldVoicesMock } = vi.hoisted(() => ({
  inworldTTSMock: vi.fn(),
  listInworldVoicesMock: vi.fn(),
}));

vi.mock("./tts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tts.js")>()),
  inworldTTS: inworldTTSMock,
  listInworldVoices: listInworldVoicesMock,
}));

import { buildInworldSpeechProvider } from "./speech-provider.js";

const request = {
  text: "Hello",
  cfg: {},
  providerConfig: { apiKey: "key", voiceId: "Sarah", modelId: "inworld-tts-1.5-max" },
  timeoutMs: 30_000,
};
const policy = createSpeechDirectivePolicy();
const overrides = { voice: "Ashley", model: "inworld-tts-1.5-mini", temperature: 0.6 };
const synthesisParams = {
  text: "Hello",
  apiKey: "key",
  baseUrl: "https://api.inworld.ai",
  voiceId: "Ashley",
  modelId: "inworld-tts-1.5-mini",
  temperature: 0.6,
  timeoutMs: 30_000,
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
      await provider.isConfiguredAsync?.({ providerConfig: { apiKey: "   " }, timeoutMs: 30_000 }),
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
    await provider.listVoices?.({ providerConfig: { apiKey: "test-key" }, timeoutMs: 30_000 });

    expect(listInworldVoicesMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-key", timeoutMs: 30_000 }),
    );
  });

  it("normalizes provider-owned speech config from raw provider config", () => {
    const config = {
      apiKey: "basic-key",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.8,
    };
    expect(
      provider.resolveConfig?.({
        ...request,
        rawConfig: {
          providers: { inworld: { ...config, baseUrl: "https://custom.inworld.example.com/" } },
        },
      }),
    ).toEqual({
      ...config,
      baseUrl: "https://custom.inworld.example.com",
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

  it.each([
    ["voice", "Ashley", { overrides: { voiceId: "Ashley" } }],
    ["model", "inworld-tts-1.5-mini", { overrides: { modelId: "inworld-tts-1.5-mini" } }],
    ["temperature", "0.7", { overrides: { temperature: 0.7 } }],
    ["temperature", "3", { warnings: ['invalid Inworld temperature "3"'] }],
  ] as const)("parses directive %s=%s", (key, value, expected) => {
    expect(provider.parseDirectiveToken?.({ key, value, policy })).toEqual({
      handled: true,
      ...expected,
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
  it.each([
    ["OGG_OPUS voice-note", false],
    ["22050 Hz telephony PCM", true],
  ] as const)("synthesizes %s", async (_label, telephony) => {
    const audioBuffer = Buffer.from(telephony ? "pcm" : "opus");
    inworldTTSMock.mockResolvedValueOnce(audioBuffer);
    const req = { ...request, providerOverrides: overrides };
    const result = telephony
      ? await provider.synthesizeTelephony?.(req)
      : await provider.synthesize({ ...req, target: "voice-note" });
    expect(inworldTTSMock).toHaveBeenCalledWith({
      ...synthesisParams,
      audioEncoding: telephony ? "PCM" : "OGG_OPUS",
      ...(telephony ? { sampleRateHertz: 22_050 } : {}),
    });
    expect(result).toEqual({
      audioBuffer,
      ...(telephony
        ? { outputFormat: "pcm", sampleRate: 22_050 }
        : { outputFormat: "ogg_opus", fileExtension: ".ogg", voiceCompatible: true }),
    });
  });
});
