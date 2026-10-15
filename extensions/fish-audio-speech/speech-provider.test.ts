import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildFishAudioSpeechProvider } from "./speech-provider.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async (params: { url: string; init?: RequestInit; timeoutMs?: number }) => {
    fetchWithSsrFGuardMock(params);
    return {
      response: await globalThis.fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    };
  },
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected Fish Audio JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("Fish Audio speech provider", () => {
  const originalFetch = globalThis.fetch;
  const provider = buildFishAudioSpeechProvider();
  const request = {
    text: "hello",
    cfg: {},
    providerConfig: { apiKey: "fish-test" },
    timeoutMs: 1_000,
  };

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchWithSsrFGuardMock.mockClear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("preserves Talk setting precedence and explicit blank-key clearing", () => {
    const params = {
      modelId: " ",
      model: "s1",
      speakerVoiceId: " voice-123 ",
      voiceId: "other",
      speed: 1.2,
    };
    const talk = provider.resolveTalkConfig?.({
      cfg: {},
      baseTtsConfig: { providers: { "fish-audio": { apiKey: "base-key", model: "s2-pro" } } },
      talkProviderConfig: { ...params, apiKey: " ", baseUrl: " " },
      timeoutMs: 1000,
    });
    expect(talk).toMatchObject({
      apiKey: undefined,
      baseUrl: "https://api.fish.audio",
      model: "s2-pro",
      referenceId: "voice-123",
      speed: 1.2,
    });
    expect(provider.resolveTalkOverrides?.({ talkProviderConfig: {}, params })).toStrictEqual({
      referenceId: "voice-123",
      speed: 1.2,
    });
  });

  it.each([undefined, "s2.1-pro", "drama-3", "drama-3-preview"])(
    "maps hosted model %s and preserves Fish expression tags",
    async (model) => {
      globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://api.fish.audio/v1/tts");
        expect(new Headers(init?.headers).get("model")).toBe(model ?? "s2.1-pro");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fish-test");
        expect(init?.body).toBe(
          '{"text":"[barely holding it together] Keep this quiet. <whisper>Now celebrate!</whisper>","format":"mp3","reference_id":"voice-123","sample_rate":44100,"latency":"normal","prosody":{"speed":1.1},"temperature":0.6,"top_p":0.8,"normalize":false}',
        );
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg" },
        });
      }) as unknown as typeof fetch;
      const result = await provider.synthesize({
        ...request,
        text: "[barely holding it together] Keep this quiet. <whisper>Now celebrate!</whisper>",
        providerConfig: {
          apiKey: "fish-test",
          model,
          speakerVoiceId: "voice-123",
          latency: "normal",
          speed: 1.1,
          temperature: 0.6,
          topP: 0.8,
          normalize: false,
        },
        target: "audio-file",
        timeoutMs: 12_345,
      });
      expect(result).toMatchObject({
        audioBuffer: Buffer.from([1, 2, 3]),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      });
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 12_345, auditContext: "fish-audio.tts" }),
      );
    },
  );

  it("uses native Opus for streamed voice notes and releases the response", async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(requestBody(init)).toMatchObject({ format: "opus", sample_rate: 48000 });
      expect(new Headers(init?.headers).get("model")).toBe("drama-3-preview");
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "audio/opus" },
      });
    }) as unknown as typeof fetch;
    const result = await provider.streamSynthesize?.({
      ...request,
      target: "voice-note",
      providerOverrides: { model: "drama-3-preview" },
    });
    expect(result).toMatchObject({
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
    const bytes = new Uint8Array(await new Response(result?.audioStream).arrayBuffer());
    expect([...bytes]).toEqual([4, 5, 6]);
    await result?.release?.();
  });

  it("requests raw 8 kHz PCM for telephony", async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(requestBody(init)).toMatchObject({ format: "pcm", sample_rate: 8000 });
      expect(new Headers(init?.headers).get("model")).toBe("drama-3-preview");
      return new Response(new Uint8Array([7, 8]));
    }) as unknown as typeof fetch;
    const providerConfig = provider.resolveTalkConfig?.({
      cfg: {},
      baseTtsConfig: { providers: { "fish-audio": request.providerConfig } },
      talkProviderConfig: { modelId: "drama-3-preview" },
      timeoutMs: request.timeoutMs,
    });
    if (!providerConfig) {
      throw new Error("expected Fish Audio Talk configuration");
    }
    const result = await provider.synthesizeTelephony?.({ ...request, providerConfig });
    expect(result).toEqual({
      audioBuffer: Buffer.from([7, 8]),
      outputFormat: "pcm",
      sampleRate: 8000,
    });
  });

  it("lists all owned pages then one public page with deduplication", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const self = parsed.searchParams.get("self") === "true";
      const page = Number(parsed.searchParams.get("page_number"));
      if (self && page === 1) {
        return Response.json({
          total: 101,
          items: Array.from({ length: 100 }, (_, index) => ({
            _id: `own-${index}`,
            title: `Own ${index}`,
          })),
        });
      }
      if (self) {
        return Response.json({ total: 101, items: [{ _id: "own-100", title: "Own 100" }] });
      }
      return Response.json({
        items: [
          { _id: "own-0", title: "Duplicate" },
          {
            _id: "public-1",
            title: "Public",
            languages: [null, " en ", "", 1],
            tags: [" warm ", false, " ", "warm"],
          },
        ],
      });
    }) as unknown as typeof fetch;
    const voices = await provider.listVoices?.({
      providerConfig: { apiKey: "fish-test" },
      timeoutMs: 9_000,
    });
    expect(voices).toHaveLength(102);
    expect(voices?.at(-1)).toMatchObject({
      id: "public-1",
      locale: "en",
      personalities: ["warm", "warm"],
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
  });

  it("rejects unknown models instead of silently falling back at Fish Audio", async () => {
    await expect(
      provider.synthesize({
        ...request,
        providerConfig: { ...request.providerConfig, model: "drama-3-typo" },
        target: "audio-file",
      }),
    ).rejects.toThrow('invalid Fish Audio model "drama-3-typo"');
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("fails closed on blank credentials before network access", async () => {
    vi.stubEnv("FISH_API_KEY", "   ");
    vi.stubEnv("FISH_AUDIO_API_KEY", "   ");
    const providerConfig = { apiKey: "   " };
    expect(await provider.isConfiguredAsync?.({ providerConfig, timeoutMs: 1_000 })).toBe(false);
    await expect(
      provider.synthesize({
        ...request,
        providerConfig,
        target: "audio-file",
      }),
    ).rejects.toThrow("Fish Audio API key missing");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each([
    { key: "model", value: "drama-3-preview", overrides: { model: "drama-3-preview" } },
    { key: "topp", value: "1", overrides: { topP: 1 } },
    { key: "speed", value: "0.5", overrides: { speed: 0.5 } },
  ])("accepts the $key=$value directive boundary", ({ key, value, overrides }) => {
    expect(
      provider.parseDirectiveToken?.({
        key,
        value,
        policy: {
          enabled: true,
          allowText: true,
          allowProvider: true,
          allowVoice: true,
          allowModelId: true,
          allowVoiceSettings: true,
          allowNormalization: true,
          allowSeed: true,
        },
      }),
    ).toEqual({ handled: true, overrides });
  });
});
