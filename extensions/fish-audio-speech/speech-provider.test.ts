import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { afterAll, afterEach, assert, expect, it, vi } from "vitest";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";
import { buildFishAudioSpeechProvider } from "./speech-provider.js";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
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

it.each(["synthesize", "stream", "voices"] as const)(
  "redacts the active credential from %s provider diagnostics",
  async (operation) => {
    const credential = "opaque-fish-secret42";
    respond(() => Response.json({ message: `provider diagnostic ${credential}` }, { status: 401 }));
    const params = {
      ...request,
      providerConfig: { apiKey: credential },
      target: "audio-file" as const,
    };
    const pending =
      operation === "synthesize"
        ? provider.synthesize(params)
        : operation === "stream"
          ? provider.streamSynthesize?.(params)
          : provider.listVoices?.(params);
    assert(pending);
    const error: unknown = await pending.catch((cause: unknown) => cause);
    assert(error instanceof Error);
    expect(formatErrorMessage(error)).not.toContain(credential);
    expect(error.message).toContain("provider diagnostic");
    expect(error).toMatchObject({ status: 401, statusCode: 401 });
  },
);

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

it.each([
  [undefined, "audio-file", "mp3", 44100],
  ["s2.1-pro", "audio-file", "mp3", 44100],
  ["drama-3", "audio-file", "mp3", 44100],
  ["drama-3-preview", "audio-file", "mp3", 44100],
  ["drama-3-preview", "voice-note", "opus", 48000],
  ["drama-3-preview", "telephony", "pcm", 8000],
] as const)("synthesizes %s for %s", async (model, target, format, sampleRate) => {
  const bytes = [1, 2, 3];
  const hosted = target === "audio-file";
  const metadata = {
    outputFormat: format,
    fileExtension: `.${format}`,
    voiceCompatible: target === "voice-note",
  };
  respond((url, init) => {
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(Object.fromEntries(new Headers(init?.headers))).toMatchObject({
      model: model ?? "s2.1-pro",
      authorization: "Bearer fish-test",
    });
    if (hosted) {
      expect(init?.body).toBe(
        '{"text":"[barely holding it together] Keep this quiet. <whisper>Now celebrate!</whisper>","format":"mp3","reference_id":"voice-123","sample_rate":44100,"latency":"normal","prosody":{"speed":1.1},"temperature":0.6,"top_p":0.8,"normalize":false}',
      );
    } else {
      if (typeof init?.body !== "string") {
        throw new Error("expected Fish Audio JSON request body");
      }
      expect(JSON.parse(init.body)).toMatchObject({ format, sample_rate: sampleRate });
    }
    return new Response(
      new Uint8Array(bytes),
      format === "pcm"
        ? undefined
        : { headers: { "content-type": format === "mp3" ? "audio/mpeg" : "audio/opus" } },
    );
  });
  let result;
  if (hosted) {
    result = await provider.synthesize({
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
      target,
      timeoutMs: 12_345,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 12_345, auditContext: "fish-audio.tts" }),
    );
  } else if (target === "voice-note") {
    result = await provider.streamSynthesize?.({
      ...request,
      target,
      providerOverrides: { model },
    });
  } else {
    const providerConfig = provider.resolveTalkConfig?.({
      ...request,
      baseTtsConfig: { providers: { "fish-audio": request.providerConfig } },
      talkProviderConfig: { modelId: model },
    });
    if (!providerConfig) {
      throw new Error("expected Fish Audio Talk configuration");
    }
    result = await provider.synthesizeTelephony?.({ ...request, providerConfig });
  }
  if (result && "audioStream" in result) {
    const { audioStream, release, ...actualMetadata } = result;
    expect(actualMetadata).toEqual(metadata);
    expect([...new Uint8Array(await new Response(audioStream).arrayBuffer())]).toEqual(bytes);
    await release?.();
  } else {
    expect(result).toEqual({
      audioBuffer: Buffer.from(bytes),
      ...(target === "telephony" ? { outputFormat: "pcm", sampleRate: 8000 } : metadata),
    });
  }
});

it("lists all owned pages then one public page with deduplication", async () => {
  const own = Array.from({ length: 101 }, (_, index) => ({ _id: `own-${index}` }));
  const publicVoice = {
    _id: "public-1",
    languages: [null, " en ", "", 1],
    tags: [" warm ", false, " ", "warm"],
  };
  respond((url) => {
    const params = new URL(url).searchParams;
    if (params.get("self") === "true") {
      const offset = (Number(params.get("page_number")) - 1) * 100;
      return Response.json({ total: own.length, items: own.slice(offset, offset + 100) });
    }
    return Response.json({ items: [{ _id: "own-0", title: "Duplicate" }, publicVoice] });
  });
  const voices = await provider.listVoices?.({ ...request, timeoutMs: 9_000 });
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
  const policy = createSpeechDirectivePolicy();
  expect(provider.parseDirectiveToken?.({ key, value, policy })).toEqual({
    handled: true,
    overrides,
  });
});
