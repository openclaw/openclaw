import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { buildFishAudioSpeechProvider } from "./speech-provider.js";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

function respond(handler: (url: string, init?: RequestInit) => Response) {
  fetchMock.mockImplementation(async ({ url, init }: { url: string; init?: RequestInit }) => ({
    response: handler(url, init),
    release: async () => {},
  }));
}

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
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

it("preserves Talk setting precedence and explicit blank-key clearing", () => {
  const params = {
    modelId: " ",
    model: "s1",
    speakerVoiceId: " voice-123 ",
    voiceId: "other",
    speed: 1.2,
  };
  expect(
    provider.resolveTalkConfig?.({
      ...request,
      baseTtsConfig: { providers: { "fish-audio": { apiKey: "base-key", model: "s2-pro" } } },
      talkProviderConfig: { ...params, apiKey: " ", baseUrl: " " },
    }),
  ).toMatchObject({
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
    respond((url, init) => {
      expect(url).toBe("https://api.fish.audio/v1/tts");
      expect(Object.fromEntries(new Headers(init?.headers))).toMatchObject({
        model: model ?? "s2.1-pro",
        authorization: "Bearer fish-test",
      });
      expect(init?.body).toBe(
        '{"text":"[barely holding it together] Keep this quiet. <whisper>Now celebrate!</whisper>","format":"mp3","reference_id":"voice-123","sample_rate":44100,"latency":"normal","prosody":{"speed":1.1},"temperature":0.6,"top_p":0.8,"normalize":false}',
      );
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    });
    expect(
      await provider.synthesize({
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
      }),
    ).toMatchObject({
      audioBuffer: Buffer.from([1, 2, 3]),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 12_345, auditContext: "fish-audio.tts" }),
    );
  },
);

it.each(["voice-note", "telephony"] as const)("uses native audio for %s", async (target) => {
  const streaming = target === "voice-note";
  const format = streaming ? "opus" : "pcm";
  const sampleRate = streaming ? 48000 : 8000;
  const bytes = streaming ? [4, 5, 6] : [7, 8];
  respond((_url, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("expected Fish Audio JSON request body");
    }
    expect(JSON.parse(init.body)).toMatchObject({ format, sample_rate: sampleRate });
    expect(new Headers(init.headers).get("model")).toBe("drama-3-preview");
    return new Response(
      new Uint8Array(bytes),
      streaming ? { headers: { "content-type": "audio/opus" } } : undefined,
    );
  });
  if (streaming) {
    const result = await provider.streamSynthesize?.({
      ...request,
      target,
      providerOverrides: { model: "drama-3-preview" },
    });
    expect(result).toMatchObject({
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
    expect([...new Uint8Array(await new Response(result?.audioStream).arrayBuffer())]).toEqual(
      bytes,
    );
    await result?.release?.();
  } else {
    const providerConfig = provider.resolveTalkConfig?.({
      ...request,
      baseTtsConfig: { providers: { "fish-audio": request.providerConfig } },
      talkProviderConfig: { modelId: "drama-3-preview" },
    });
    if (!providerConfig) {
      throw new Error("expected Fish Audio Talk configuration");
    }
    expect(await provider.synthesizeTelephony?.({ ...request, providerConfig })).toEqual({
      audioBuffer: Buffer.from(bytes),
      outputFormat: "pcm",
      sampleRate: 8000,
    });
  }
});

it("lists all owned pages then one public page with deduplication", async () => {
  const own = Array.from({ length: 101 }, (_, index) => ({ _id: `own-${index}` }));
  respond((url) => {
    const params = new URL(url).searchParams;
    if (params.get("self") === "true") {
      const offset = (Number(params.get("page_number")) - 1) * 100;
      return Response.json({ total: own.length, items: own.slice(offset, offset + 100) });
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
  });
  const voices = await provider.listVoices?.({
    providerConfig: request.providerConfig,
    timeoutMs: 9_000,
  });
  expect(voices).toHaveLength(102);
  expect(voices?.at(-1)).toMatchObject({
    id: "public-1",
    locale: "en",
    personalities: ["warm", "warm"],
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it.each([
  ["model", "drama-3-typo", 'invalid Fish Audio model "drama-3-typo"'],
  ["apiKey", "   ", "Fish Audio API key missing"],
])("rejects invalid %s before network access", async (key, value, error) => {
  vi.stubEnv("FISH_API_KEY", "   ");
  vi.stubEnv("FISH_AUDIO_API_KEY", "   ");
  const providerConfig = { ...request.providerConfig, [key]: value };
  if (key === "apiKey") {
    expect(await provider.isConfiguredAsync?.({ providerConfig, timeoutMs: 1_000 })).toBe(false);
  }
  await expect(
    provider.synthesize({ ...request, providerConfig, target: "audio-file" }),
  ).rejects.toThrow(error);
  expect(fetchMock).not.toHaveBeenCalled();
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
