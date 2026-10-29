import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { afterAll, afterEach, assert, expect, it, vi } from "vitest";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";
import { buildFishAudioSpeechProvider } from "./speech-provider.js";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchMock,
}));

function respond(handler: (url: string, init?: RequestInit) => Response) {
  fetchMock.mockImplementation(async ({ url, init }: { url: string; init?: RequestInit }) => ({
    response: handler(url, init),
    release: async () => {},
  }));
}

const provider = buildFishAudioSpeechProvider();
const request = { text: "hi", cfg: {}, providerConfig: { apiKey: "key" }, timeoutMs: 1_000 };
afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

const diagnosticMethods = ["synthesize", "streamSynthesize", "listVoices"] as const;
it.each(diagnosticMethods)("redacts %s diagnostics", async (operation) => {
  const apiKey = "opaque-fish-secret42";
  respond(() => Response.json({ message: `provider diagnostic ${apiKey}` }, { status: 401 }));
  const error: unknown = await provider[operation]?.({
    ...request,
    providerConfig: { apiKey },
    target: "audio-file",
  }).catch((cause: unknown) => cause);
  assert(error instanceof Error);
  expect(formatErrorMessage(error)).not.toContain(apiKey);
  expect(error.message).toContain("provider diagnostic");
  expect(error).toMatchObject({ status: 401, statusCode: 401 });
});

it("preserves Talk setting precedence and explicit blank-key clearing", () => {
  const params = { modelId: " ", model: "s1", speakerVoiceId: " v ", voiceId: "x", speed: 1.2 };
  const overrides = { referenceId: "v", speed: 1.2 };
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
    ...overrides,
  });
  expect(provider.resolveTalkOverrides?.({ talkProviderConfig: {}, params })).toStrictEqual(
    overrides,
  );
});

it.each([
  ["synthesize", undefined, "audio-file", "mp3", 44100],
  ["synthesize", "drama-3", "audio-file", "mp3", 44100],
  ["streamSynthesize", "drama-3-preview", "voice-note", "opus", 48000],
  ["synthesizeTelephony", "drama-3-preview", "telephony", "pcm", 8000],
] as const)("%s with %s", async (method, model, target, outputFormat, sampleRate) => {
  const audioBuffer = Buffer.from([1, 2, 3]);
  const text = "[sad] x <whisper>y</whisper>";
  const voiceCompatible = target === "voice-note";
  const providerConfig = {
    ...request.providerConfig,
    model: target === "audio-file" ? model : undefined,
    speakerVoiceId: "v",
    latency: "normal",
    speed: 1.1,
    temperature: 0.6,
    topP: 0.8,
    normalize: false,
  };
  respond((url, init) => {
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(Object.fromEntries(new Headers(init?.headers))).toMatchObject({
      model: model ?? "s2.1-pro",
      authorization: "Bearer key",
    });
    expect(init?.body).toBe(
      `{"text":"${text}","format":"${outputFormat}","reference_id":"v","sample_rate":${sampleRate},"latency":"normal","prosody":{"speed":1.1},"temperature":0.6,"top_p":0.8,"normalize":false}`,
    );
    const type = outputFormat === "mp3" ? "audio/mpeg" : "audio/opus";
    return new Response(
      audioBuffer,
      outputFormat === "pcm" ? undefined : { headers: { "content-type": type } },
    );
  });
  const talkConfig =
    target === "telephony"
      ? provider.resolveTalkConfig?.({
          ...request,
          baseTtsConfig: { providers: { "fish-audio": providerConfig } },
          talkProviderConfig: { modelId: model },
        })
      : providerConfig;
  assert(talkConfig);
  const params = { ...request, text, target, providerConfig: talkConfig, timeoutMs: 12_345 };
  const providerOverrides = voiceCompatible ? { model } : undefined;
  const result = await provider[method]?.({ ...params, providerOverrides });
  assert(result);
  const metadata =
    target === "telephony"
      ? { outputFormat, sampleRate }
      : { outputFormat, fileExtension: `.${outputFormat}`, voiceCompatible };
  expect(result).toMatchObject(metadata);
  const audio =
    "audioStream" in result
      ? Buffer.from(await new Response(result.audioStream).arrayBuffer())
      : result.audioBuffer;
  expect(audio).toEqual(audioBuffer);
  if ("release" in result) {
    await result.release?.();
  }
});

it("lists all owned pages then one public page with deduplication", async () => {
  const own = Array.from({ length: 101 }, (_, index) => ({ _id: `own-${index}` }));
  const voice = { _id: "p", languages: [" en "], tags: [" w ", false, " ", "w"] };
  respond((url) => {
    const params = new URL(url).searchParams;
    if (params.get("self") === "true") {
      const offset = (Number(params.get("page_number")) - 1) * 100;
      return Response.json({ total: own.length, items: own.slice(offset, offset + 100) });
    }
    return Response.json({ items: [{ _id: "own-0", title: "Duplicate" }, voice] });
  });
  const voices = await provider.listVoices?.({ ...request, timeoutMs: 9_000 });
  expect(voices).toHaveLength(102);
  expect(voices?.at(-1)).toMatchObject({ id: "p", locale: "en", personalities: ["w", "w"] });
});

it.each([
  ["model", "drama-3-typo", 'invalid Fish Audio model "drama-3-typo"'],
  ["apiKey", "   ", "Fish Audio API key missing"],
])("rejects invalid %s before network access", async (key, value, error) => {
  vi.stubEnv("FISH_API_KEY", "   ");
  vi.stubEnv("FISH_AUDIO_API_KEY", "   ");
  const providerConfig = { ...request.providerConfig, [key]: value };
  if (key === "apiKey") {
    expect(await provider.isConfiguredAsync?.({ ...request, providerConfig })).toBe(false);
  }
  await expect(
    provider.synthesize({ ...request, providerConfig, target: "audio-file" }),
  ).rejects.toThrow(error);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  ["model", "drama-3-preview", { model: "drama-3-preview" }],
  ["topp", "1", { topP: 1 }],
  ["speed", "0.5", { speed: 0.5 }],
] as const)("accepts %s=%s directives", (key, value, overrides) => {
  const policy = createSpeechDirectivePolicy();
  expect(provider.parseDirectiveToken?.({ key, value, policy })).toEqual({
    handled: true,
    overrides,
  });
});
