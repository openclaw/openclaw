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
            speakingRate: 1.3,
            deliveryMode: "balanced",
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
      speakingRate: 1.3,
      deliveryMode: "BALANCED",
    });
  });

  it("drops out-of-range speakingRate from provider config", () => {
    const resolved = provider.resolveConfig?.({
      cfg: {},
      timeoutMs: 30_000,
      rawConfig: {
        providers: { inworld: { apiKey: "basic-key", speakingRate: 2, deliveryMode: "wild" } },
      },
    });

    expect(resolved).toEqual({
      apiKey: "basic-key",
      baseUrl: "https://api.inworld.ai",
      voiceId: "Sarah",
      modelId: "inworld-tts-1.5-max",
      temperature: undefined,
      speakingRate: undefined,
      deliveryMode: undefined,
    });
  });

  it("preserves inherited Talk settings when overrides are blank", () => {
    const talkProviderConfig = {
      voiceId: " ",
      modelId: " inworld-tts-1.5-mini ",
      temperature: 0.5,
      speakingRate: 1.2,
      deliveryMode: "stable",
    };
    const talk = provider.resolveTalkConfig?.({
      cfg: {},
      baseTtsConfig: { providers: { inworld: { apiKey: "base-key", voiceId: "Ashley" } } },
      talkProviderConfig: { ...talkProviderConfig, apiKey: " ", baseUrl: " " },
      timeoutMs: 1000,
    });
    expect(talk).toMatchObject({
      apiKey: "base-key",
      baseUrl: "https://api.inworld.ai",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.5,
      speakingRate: 1.2,
      deliveryMode: "STABLE",
    });
    expect(
      provider.resolveTalkConfig?.({
        cfg: {},
        baseTtsConfig: {
          providers: { inworld: { temperature: 0.8, speakingRate: 1.1, deliveryMode: "BALANCED" } },
        },
        talkProviderConfig: { temperature: 0, speakingRate: 3, deliveryMode: " " },
        timeoutMs: 1000,
      }),
    ).toMatchObject({ temperature: 0.8, speakingRate: 1.1, deliveryMode: "BALANCED" });
    // talk.speak params carry pace as `speed`; per-call deliveryMode is not part of the Talk schema.
    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: {},
        params: { voiceId: " ", modelId: " inworld-tts-1.5-mini ", temperature: 0.5, speed: 1.3 },
      }),
    ).toStrictEqual({
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.5,
      speakingRate: 1.3,
    });
    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: {},
        params: { text: "Hello", speed: 3 },
      }),
    ).toStrictEqual({});
  });

  it.each([
    ["voice", "Ashley", { overrides: { voiceId: "Ashley" } }],
    ["model", "inworld-tts-1.5-mini", { overrides: { modelId: "inworld-tts-1.5-mini" } }],
    ["temperature", "0.7", { overrides: { temperature: 0.7 } }],
    ["speed", "1.3", { overrides: { speakingRate: 1.3 } }],
    ["speaking_rate", "0.9", { overrides: { speakingRate: 0.9 } }],
    ["temperature", "3", { warnings: ['invalid Inworld temperature "3"'] }],
  ] as const)("parses directive %s=%s", (key, value, expected) => {
    expect(provider.parseDirectiveToken?.({ key, value, policy })).toEqual({
      handled: true,
      ...expected,
    });
  });

  it("parses and validates Inworld delivery mode directives", () => {
    expect(provider.parseDirectiveToken?.({ key: "delivery", value: "creative", policy })).toEqual({
      handled: true,
      overrides: { deliveryMode: "CREATIVE" },
    });
    expect(provider.parseDirectiveToken?.({ key: "delivery_mode", value: "wild", policy })).toEqual(
      {
        handled: true,
        warnings: ['invalid Inworld delivery mode "wild" (stable, balanced, creative)'],
      },
    );
    expect(
      provider.parseDirectiveToken?.({
        key: "delivery",
        value: "creative",
        policy: { ...policy, allowVoiceSettings: false },
      }),
    ).toEqual({ handled: true });
  });

  it.each(["2", "0.4", "fast"])("warns on invalid directive speaking rate %s", (value) => {
    expect(provider.parseDirectiveToken?.({ key: "speed", value, policy })).toEqual({
      handled: true,
      warnings: [`invalid Inworld speaking rate "${value}" (0.5-1.5)`],
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
    const req = {
      ...request,
      providerOverrides: { ...overrides, ...(!telephony ? { speed: 1.3 } : {}) },
    };
    const result = telephony
      ? await provider.synthesizeTelephony?.(req)
      : await provider.synthesize({ ...req, target: "voice-note" });
    expect(inworldTTSMock).toHaveBeenCalledWith({
      ...synthesisParams,
      speakingRate: telephony ? undefined : 1.3,
      deliveryMode: undefined,
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
