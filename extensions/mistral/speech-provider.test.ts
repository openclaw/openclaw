import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  parseTtsDirectives,
  type SpeechProviderPlugin,
  type SpeechSynthesisRequest,
} from "openclaw/plugin-sdk/speech";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMistralSpeechProvider, decodeMistralWavToS16le } from "./speech-provider.js";

/** Build a minimal RIFF/WAVE buffer with f32le mono audio at the given sample rate. */
function buildF32leWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(3, 20); // audioFormat: IEEE float
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); // byte rate
  buf.writeUInt16LE(4, 32); // block align
  buf.writeUInt16LE(32, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeFloatLE(samples[i], 44 + i * 4);
  }
  return buf;
}

/** Build a minimal RIFF/WAVE buffer with s16le mono audio at the given sample rate. */
function buildS16leWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // audioFormat: PCM integer
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}

function insertChunkBeforeData(buffer: Buffer, chunkId: string, payload: Buffer): Buffer {
  const padBytes = payload.length % 2;
  const chunk = Buffer.alloc(8 + payload.length + padBytes);
  chunk.write(chunkId, 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);

  const wavWithChunk = Buffer.concat([buffer.subarray(0, 36), chunk, buffer.subarray(36)]);
  wavWithChunk.writeUInt32LE(wavWithChunk.length - 8, 4);
  return wavWithChunk;
}

describe("mistral speech provider", () => {
  const originalFetch = globalThis.fetch;
  const provider = buildMistralSpeechProvider();

  function buildSynthesisRequest(
    overrides: Partial<SpeechSynthesisRequest> = {},
  ): SpeechSynthesisRequest {
    return {
      text: "hello",
      cfg: {
        auth: {
          profiles: {
            "mistral:default": {
              provider: "mistral",
              mode: "api_key",
            },
          },
        },
      } as never,
      providerConfig: {
        baseUrl: "https://api.mistral.ai/v1",
        model: "voxtral-mini-tts-2603",
        voice: "",
      },
      target: "voice-note",
      timeoutMs: 5000,
      ...overrides,
    };
  }

  const modelOverridePolicy = {
    enabled: true,
    allowText: false,
    allowProvider: false,
    allowVoice: true,
    allowModelId: true,
    allowVoiceSettings: false,
    allowNormalization: false,
    allowSeed: false,
  } as const;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_TTS_BASE_URL;
  });

  it("treats configured Mistral auth profiles as TTS-ready", () => {
    expect(
      provider.isConfigured({
        cfg: {
          auth: {
            profiles: {
              "mistral:default": {
                provider: "mistral",
                mode: "api_key",
              },
            },
          },
        } as never,
        providerConfig: {},
        timeoutMs: 5000,
      }),
    ).toBe(true);
  });

  it("treats auth.order with a Mistral profile list as TTS-ready", () => {
    expect(
      provider.isConfigured({
        cfg: {
          auth: {
            order: {
              mistral: ["mistral:default"],
            },
          },
        } as never,
        providerConfig: {},
        timeoutMs: 5000,
      }),
    ).toBe(true);
  });

  it("does not treat an empty auth.order Mistral list as TTS-ready", () => {
    expect(
      provider.isConfigured({
        cfg: {
          auth: {
            order: {
              mistral: [],
            },
          },
        } as never,
        providerConfig: {},
        timeoutMs: 5000,
      }),
    ).toBe(false);
  });

  it("gates profile metadata on an explicit empty auth.order Mistral entry", () => {
    // auth.order.mistral=[] is authoritative: resolveAuthProfileOrder returns []
    // even when profiles exist, so synthesis would fail. isConfigured must agree.
    expect(
      provider.isConfigured({
        cfg: {
          auth: {
            profiles: {
              "mistral:default": { provider: "mistral", mode: "api_key" },
            },
            order: {
              mistral: [],
            },
          },
        } as never,
        providerConfig: {},
        timeoutMs: 5000,
      }),
    ).toBe(false);
  });

  it("treats no cfg-level Mistral metadata as TTS-ready for auth-store-only credentials", () => {
    // When cfg has no Mistral profiles and no Mistral auth.order entry,
    // resolveApiKeyForProvider falls through to the auth store. isConfigured
    // must return true so the provider is not skipped for users whose only
    // credentials live in auth-profiles.json.
    expect(
      provider.isConfigured({
        cfg: {} as never,
        providerConfig: {},
        timeoutMs: 5000,
      }),
    ).toBe(true);
  });

  it("reuses the Mistral model provider baseUrl when no TTS override is configured", () => {
    const providerConfig = provider.resolveConfig?.({
      cfg: {
        models: {
          providers: {
            mistral: {
              baseUrl: "https://custom.mistral.example/v1",
            },
          },
        },
      } as never,
      rawConfig: {},
      timeoutMs: 5000,
    });

    expect(providerConfig).toMatchObject({
      baseUrl: "https://custom.mistral.example/v1",
      model: "voxtral-mini-tts-2603",
    });
  });

  it("maps Talk config modelId and voiceId onto the Mistral TTS config shape", () => {
    const talkConfig = provider.resolveTalkConfig?.({
      cfg: {
        models: {
          providers: {
            mistral: {
              baseUrl: "https://base.mistral.example/v1",
            },
          },
        },
      } as never,
      baseTtsConfig: {},
      talkProviderConfig: {
        apiKey: "talk-mistral-key",
        baseUrl: "https://talk.mistral.example/v1",
        modelId: "voxtral-custom-tts",
        voiceId: "voice_123",
        speed: 1.1,
      },
      timeoutMs: 5000,
    });

    expect(talkConfig).toMatchObject({
      apiKey: "talk-mistral-key",
      baseUrl: "https://talk.mistral.example/v1",
      model: "voxtral-custom-tts",
      voice: "voice_123",
      speed: 1.1,
    });
  });

  it("maps Talk request overrides onto Mistral speech overrides", () => {
    const talkOverrides = provider.resolveTalkOverrides?.({
      talkProviderConfig: {},
      params: {
        modelId: "voxtral-live-tts",
        voiceId: "voice_override",
        speed: 1.25,
      },
    });

    expect(talkOverrides).toEqual({
      model: "voxtral-live-tts",
      voice: "voice_override",
      speed: 1.25,
    });
  });

  it("accepts provider-specific camelCase directive aliases for Mistral", () => {
    const result = parseTtsDirectives(
      "Hello [[tts:mistralVoiceId=voice_abc mistralModelId=voxtral-live-tts]] world",
      modelOverridePolicy,
      { providers: [provider] },
    );
    const mistralOverrides = result.overrides.providerOverrides?.mistral as
      | { voice?: string; model?: string }
      | undefined;

    expect(mistralOverrides).toEqual({
      voice: "voice_abc",
      model: "voxtral-live-tts",
    });
    expect(result.warnings).toEqual([]);
  });

  it("does not swallow bare model directives meant for a later provider", () => {
    const laterProvider: SpeechProviderPlugin = {
      id: "elevenlabs",
      label: "ElevenLabs",
      autoSelectOrder: 20,
      isConfigured: () => true,
      parseDirectiveToken: ({ key, value }) =>
        key === "model" ? { handled: true, overrides: { modelId: value } } : { handled: false },
      synthesize: async () => ({
        audioBuffer: Buffer.from("audio"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      }),
    };

    const result = parseTtsDirectives(
      "Hello [[tts:provider=elevenlabs model=eleven_v3]] world",
      {
        ...modelOverridePolicy,
        allowProvider: true,
      },
      { providers: [provider, laterProvider] },
    );

    expect(result.overrides.provider).toBe("elevenlabs");
    expect(result.overrides.providerOverrides?.mistral).toBeUndefined();
    expect(result.overrides.providerOverrides?.elevenlabs).toEqual({
      modelId: "eleven_v3",
    });
  });

  it("prefers provider auth resolution over the raw env fallback", async () => {
    const audio = Buffer.from("fake-opus-audio");
    process.env.MISTRAL_API_KEY = "env-mistral-key";
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "resolved-profile-key",
      source: "profile:mistral:default",
      mode: "api-key",
      profileId: "mistral:default",
    });
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("voxtral-mini-tts-2603");
      expect(body.voice_id).toBeUndefined();
      expect(body.response_format).toBe("opus");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer resolved-profile-key",
      });
      return new Response(JSON.stringify({ audio_data: audio.toString("base64") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesize(buildSynthesisRequest());

    expect(result.audioBuffer.equals(audio)).toBe(true);
    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".opus");
    expect(result.voiceCompatible).toBe(true);
  });

  it("surfaces Mistral API error details from non-2xx responses", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "resolved-profile-key",
      source: "profile:mistral:default",
      mode: "api-key",
      profileId: "mistral:default",
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "bad credentials",
            type: "invalid_request",
            code: "bad_auth",
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    await expect(provider.synthesize(buildSynthesisRequest())).rejects.toThrow(
      "Mistral TTS API error (401): bad credentials [type=invalid_request, code=bad_auth]",
    );
  });

  it("throws when Voxtral omits audio_data from the response envelope", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "resolved-profile-key",
      source: "profile:mistral:default",
      mode: "api-key",
      profileId: "mistral:default",
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "tts_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(provider.synthesize(buildSynthesisRequest())).rejects.toThrow(
      "Mistral TTS response missing audio_data",
    );
  });

  it("synthesizes telephony audio by requesting WAV and decoding f32le to s16le", async () => {
    const samples = new Float32Array([0.5, -0.5, 0.25]);
    const wavBuf = buildF32leWav(samples, 24_000);
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "resolved-profile-key",
      source: "profile:mistral:default",
      mode: "api-key",
      profileId: "mistral:default",
    });
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.response_format).toBe("wav");
      return new Response(JSON.stringify({ audio_data: wavBuf.toString("base64") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesizeTelephony!({
      text: "hello",
      cfg: {
        auth: {
          profiles: {
            "mistral:default": { provider: "mistral", mode: "api_key" },
          },
        },
      } as never,
      providerConfig: {
        baseUrl: "https://api.mistral.ai/v1",
        model: "voxtral-mini-tts-2603",
        voice: "",
      },
      timeoutMs: 5000,
    });

    expect(result.outputFormat).toBe("pcm");
    expect(result.sampleRate).toBe(24_000);
    // 3 f32 samples → 3 s16 samples = 6 bytes
    expect(result.audioBuffer.byteLength).toBe(6);
  });

  it("throws when no Mistral API key can be resolved", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      source: "env: MISTRAL_API_KEY",
      mode: "api-key",
    });

    await expect(
      provider.synthesize(
        buildSynthesisRequest({
          cfg: {} as never,
        }),
      ),
    ).rejects.toThrow('No API key resolved for provider "mistral" (auth mode: api-key).');
  });
});

describe("decodeMistralWavToS16le", () => {
  it("converts f32le mono WAV to s16le and returns the sample rate from the header", () => {
    const samples = new Float32Array([1.0, -1.0, 0.5, 0.0]);
    const wav = buildF32leWav(samples, 24_000);
    const { audioBuffer, sampleRate } = decodeMistralWavToS16le(wav);
    expect(sampleRate).toBe(24_000);
    expect(audioBuffer.byteLength).toBe(samples.length * 2);
    expect(audioBuffer.readInt16LE(0)).toBe(32767);
    expect(audioBuffer.readInt16LE(2)).toBe(-32767);
  });

  it("finds the data chunk after an odd-sized metadata chunk", () => {
    const samples = new Float32Array([1.0, -1.0]);
    const wav = insertChunkBeforeData(buildF32leWav(samples, 24_000), "LIST", Buffer.from("abc"));
    const { audioBuffer, sampleRate } = decodeMistralWavToS16le(wav);
    expect(sampleRate).toBe(24_000);
    expect(audioBuffer.byteLength).toBe(samples.length * 2);
    expect(audioBuffer.readInt16LE(0)).toBe(32767);
    expect(audioBuffer.readInt16LE(2)).toBe(-32767);
  });

  it("passes through s16le mono WAV unchanged and returns the correct sample rate", () => {
    const samples = new Int16Array([1000, -2000, 0, 32767]);
    const wav = buildS16leWav(samples, 16_000);
    const { audioBuffer, sampleRate } = decodeMistralWavToS16le(wav);
    expect(sampleRate).toBe(16_000);
    expect(audioBuffer.byteLength).toBe(samples.length * 2);
    expect(audioBuffer.readInt16LE(0)).toBe(1000);
    expect(audioBuffer.readInt16LE(6)).toBe(32767);
  });

  it("throws on a truncated buffer", () => {
    expect(() => decodeMistralWavToS16le(Buffer.alloc(10))).toThrow(
      "Mistral TTS WAV response too short",
    );
  });

  it("throws on a non-WAV buffer", () => {
    const buf = Buffer.alloc(44);
    buf.write("NOPE", 0, "ascii");
    expect(() => decodeMistralWavToS16le(buf)).toThrow(
      "Mistral TTS WAV response is not a valid RIFF/WAVE file",
    );
  });
});
