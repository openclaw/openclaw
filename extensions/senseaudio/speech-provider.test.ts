import type {
  SpeechProviderConfig,
  SpeechSynthesisRequest,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: vi.fn(async () => Buffer.from("OPUS_FAKE")),
}));

vi.mock("./tts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tts.js")>();
  return {
    ...actual,
    senseAudioTTS: vi.fn(async () => Buffer.from("MP3_FAKE")),
    listSenseAudioSystemVoices: vi.fn(
      async () =>
        [{ id: "female_0033_b", name: "F33", category: "system" }] satisfies SpeechVoiceOption[],
    ),
  };
});

import { transcodeAudioBufferToOpus } from "openclaw/plugin-sdk/media-runtime";
import { buildSenseAudioSpeechProvider } from "./speech-provider.js";
import * as ttsModule from "./tts.js";

const mockedSenseAudioTTS = vi.mocked(ttsModule.senseAudioTTS);
const mockedListSystemVoices = vi.mocked(ttsModule.listSenseAudioSystemVoices);
const mockedTranscode = vi.mocked(transcodeAudioBufferToOpus);

function makeReq(overrides: Partial<SpeechSynthesisRequest> = {}): SpeechSynthesisRequest {
  return {
    text: "你好",
    cfg: {} as never,
    providerConfig: {
      apiKey: "test-key",
    } as unknown as SpeechProviderConfig,
    target: "audio-file",
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("buildSenseAudioSpeechProvider — registration shape", () => {
  it("exposes id, label, autoSelectOrder and the flagship TTS model", () => {
    const provider = buildSenseAudioSpeechProvider();
    expect(provider.id).toBe("senseaudio");
    expect(provider.label).toBe("SenseAudio");
    expect(provider.autoSelectOrder).toBe(45);
    expect(provider.models).toEqual(["senseaudio-tts-1.5-260319"]);
  });
});

describe("buildSenseAudioSpeechProvider — resolveConfig", () => {
  it("returns documented defaults when raw config is empty", () => {
    const provider = buildSenseAudioSpeechProvider();
    const config = provider.resolveConfig?.({ rawConfig: {} } as never) as Record<string, unknown>;
    expect(config.baseUrl).toBe("https://api.senseaudio.cn");
    expect(config.modelId).toBe("senseaudio-tts-1.5-260319");
    expect(config.voiceId).toBe("female_0033_b");
    expect(config.apiKey).toBeUndefined();
  });

  it("reads providers.senseaudio.* overrides and strips trailing /v1 in baseUrl", () => {
    const provider = buildSenseAudioSpeechProvider();
    const config = provider.resolveConfig?.({
      rawConfig: {
        providers: {
          senseaudio: {
            apiKey: "real-key",
            baseUrl: "https://custom.example.com/v1/",
            voiceId: "custom-voice",
            modelId: "custom-model",
          },
        },
      },
    } as never) as Record<string, unknown>;
    expect(config.apiKey).toBe("real-key");
    expect(config.baseUrl).toBe("https://custom.example.com");
    expect(config.voiceId).toBe("custom-voice");
    expect(config.modelId).toBe("custom-model");
  });
});

describe("buildSenseAudioSpeechProvider — isConfigured", () => {
  const originalEnv = process.env.SENSEAUDIO_API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SENSEAUDIO_API_KEY;
    } else {
      process.env.SENSEAUDIO_API_KEY = originalEnv;
    }
  });

  it("returns true when providerConfig has an apiKey", () => {
    delete process.env.SENSEAUDIO_API_KEY;
    const provider = buildSenseAudioSpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "explicit" } as unknown as SpeechProviderConfig,
      } as never),
    ).toBe(true);
  });

  it("returns true when only SENSEAUDIO_API_KEY env var is set", () => {
    process.env.SENSEAUDIO_API_KEY = "env-key";
    const provider = buildSenseAudioSpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: {} as SpeechProviderConfig,
      } as never),
    ).toBe(true);
  });

  it("returns false when neither config apiKey nor env var is set", () => {
    delete process.env.SENSEAUDIO_API_KEY;
    const provider = buildSenseAudioSpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: {} as SpeechProviderConfig,
      } as never),
    ).toBe(false);
  });
});

describe("buildSenseAudioSpeechProvider — parseDirectiveToken", () => {
  it("captures voiceId via voice/voiceid/voice_id keys", () => {
    const provider = buildSenseAudioSpeechProvider();
    for (const key of ["voice", "voiceid", "voice_id", "senseaudio_voice"] as const) {
      const result = provider.parseDirectiveToken?.({
        key,
        value: "custom-voice",
        currentOverrides: {},
        policy: { allowVoice: true, allowModelId: true, allowVoiceSettings: true } as never,
      } as never);
      expect(result?.handled).toBe(true);
      expect((result?.overrides as { voiceId?: string } | undefined)?.voiceId).toBe("custom-voice");
    }
  });

  it("captures modelId via model/modelid/model_id keys", () => {
    const provider = buildSenseAudioSpeechProvider();
    for (const key of ["model", "modelid", "model_id", "senseaudio_model"] as const) {
      const result = provider.parseDirectiveToken?.({
        key,
        value: "custom-model",
        currentOverrides: {},
        policy: { allowVoice: true, allowModelId: true, allowVoiceSettings: true } as never,
      } as never);
      expect(result?.handled).toBe(true);
      expect((result?.overrides as { modelId?: string } | undefined)?.modelId).toBe("custom-model");
    }
  });

  it("returns handled=false for unsupported keys such as speed/vol/pitch", () => {
    const provider = buildSenseAudioSpeechProvider();
    for (const key of ["speed", "vol", "pitch", "emotion"] as const) {
      const result = provider.parseDirectiveToken?.({
        key,
        value: "1.0",
        currentOverrides: {},
        policy: { allowVoice: true, allowModelId: true, allowVoiceSettings: true } as never,
      } as never);
      expect(result?.handled).toBe(false);
    }
  });
});

describe("buildSenseAudioSpeechProvider — synthesize", () => {
  beforeEach(() => {
    mockedSenseAudioTTS.mockClear();
    mockedListSystemVoices.mockClear();
    mockedTranscode.mockClear();
    mockedSenseAudioTTS.mockResolvedValue(Buffer.from("MP3_FAKE"));
    mockedTranscode.mockResolvedValue(Buffer.from("OPUS_FAKE"));
  });

  it("returns MP3 with voiceCompatible=false for audio-file target", async () => {
    const provider = buildSenseAudioSpeechProvider();
    const result = await provider.synthesize(makeReq());
    expect(mockedSenseAudioTTS).toHaveBeenCalledTimes(1);
    expect(mockedTranscode).not.toHaveBeenCalled();
    expect(result).toEqual({
      audioBuffer: Buffer.from("MP3_FAKE"),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
  });

  it("forwards provider overrides into the network call", async () => {
    const provider = buildSenseAudioSpeechProvider();
    await provider.synthesize(
      makeReq({
        providerOverrides: {
          voiceId: "override-voice",
          modelId: "override-model",
        } as never,
      }),
    );
    const call = mockedSenseAudioTTS.mock.calls[0]?.[0];
    expect(call?.voiceId).toBe("override-voice");
    expect(call?.model).toBe("override-model");
  });

  it("transcodes to opus + voiceCompatible=true for voice-note target", async () => {
    const provider = buildSenseAudioSpeechProvider();
    const result = await provider.synthesize(makeReq({ target: "voice-note" }));
    expect(mockedSenseAudioTTS).toHaveBeenCalledTimes(1);
    expect(mockedTranscode).toHaveBeenCalledTimes(1);
    const transcodeArg = mockedTranscode.mock.calls[0]?.[0];
    expect(transcodeArg?.audioBuffer.equals(Buffer.from("MP3_FAKE"))).toBe(true);
    expect(transcodeArg?.inputExtension).toBe("mp3");
    expect(result).toEqual({
      audioBuffer: Buffer.from("OPUS_FAKE"),
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
  });

  it("throws when neither config apiKey nor env var is set", async () => {
    const originalEnv = process.env.SENSEAUDIO_API_KEY;
    delete process.env.SENSEAUDIO_API_KEY;
    try {
      const provider = buildSenseAudioSpeechProvider();
      await expect(
        provider.synthesize(makeReq({ providerConfig: {} as SpeechProviderConfig })),
      ).rejects.toThrow(/api key missing/i);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SENSEAUDIO_API_KEY;
      } else {
        process.env.SENSEAUDIO_API_KEY = originalEnv;
      }
    }
  });
});

describe("buildSenseAudioSpeechProvider — listVoices", () => {
  beforeEach(() => {
    mockedListSystemVoices.mockClear();
  });

  it("forwards apiKey + baseUrl to listSenseAudioSystemVoices", async () => {
    mockedListSystemVoices.mockResolvedValue([
      { id: "female_0033_b", name: "F33", category: "system" },
    ]);
    const provider = buildSenseAudioSpeechProvider();
    const voices = await provider.listVoices?.({
      apiKey: "test-key",
      baseUrl: "https://custom.example.com",
    } as never);
    expect(voices).toEqual([{ id: "female_0033_b", name: "F33", category: "system" }]);
    const call = mockedListSystemVoices.mock.calls[0]?.[0];
    expect(call?.apiKey).toBe("test-key");
    expect(call?.baseUrl).toBe("https://custom.example.com");
  });
});
