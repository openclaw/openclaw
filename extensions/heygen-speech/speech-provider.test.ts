import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { createServer } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { afterAll, afterEach, assert, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";
import { buildHeyGenSpeechProvider } from "./speech-provider.js";

const fetchMock = vi.hoisted(() => vi.fn());
const transcodeMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchMock,
}));
// mock-isolation: Capture speech transcoding without invoking ffmpeg.
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: transcodeMock,
}));

function respond(handler: (url: string, init?: RequestInit) => Response) {
  fetchMock.mockImplementation(async ({ url, init }: { url: string; init?: RequestInit }) => ({
    response: handler(url, init),
    release: async () => {},
  }));
}

const provider = buildHeyGenSpeechProvider();
const request = { text: "hi", cfg: {}, providerConfig: { apiKey: "key" }, timeoutMs: 1_000 };

async function streamSpeech(providerConfig: Record<string, unknown>, extra = {}) {
  const result = await provider.streamSynthesize?.({
    ...request,
    providerConfig: { ...request.providerConfig, ...providerConfig },
    target: "audio-file",
    ...extra,
  });
  assert(result);
  return result;
}

const readAudio = async (stream: ReadableStream<Uint8Array>) =>
  Buffer.from(await new Response(stream).arrayBuffer());

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("openclaw/plugin-sdk/media-runtime");
  vi.resetModules();
});
afterEach(() => {
  fetchMock.mockReset();
  transcodeMock.mockReset();
  vi.unstubAllEnvs();
});

it.each(["synthesize", "streamSynthesize", "synthesizeTelephony", "listVoices"] as const)(
  "redacts %s diagnostics and keeps the code",
  async (operation) => {
    const apiKey = "opaque-heygen-secret42";
    respond(() =>
      Response.json(
        { error: { code: "unauthorized", message: `provider diagnostic ${apiKey}` } },
        { status: 401, headers: { "x-request-id": "req-1" } },
      ),
    );
    const error: unknown = await provider[operation]?.({
      ...request,
      providerConfig: { apiKey },
      target: "audio-file",
    }).catch((cause: unknown) => cause);
    assert(error instanceof Error);
    expect(formatErrorMessage(error)).not.toContain(apiKey);
    expect(error.message).toContain("provider diagnostic");
    expect(error.message).toContain("[code=unauthorized]");
    expect(error.message).toContain("[request_id=req-1]");
    expect(error).toMatchObject({ status: 401, statusCode: 401 });
  },
);

const mp3 = { encoding: "mp3", sample_rate_hertz: 44_100 };
const pcm = { encoding: "pcm", sample_rate_hertz: 24_000 };
const mp3Result = { outputFormat: "mp3", fileExtension: ".mp3", voiceCompatible: false };
it.each([
  ["synthesize", "audio/mpeg", mp3, mp3Result],
  ["streamSynthesize", "audio/mpeg", mp3, mp3Result],
  ["synthesizeTelephony", "audio/pcm", pcm, { outputFormat: "pcm", sampleRate: 24_000 }],
] as const)("%s posts one request over HTTP", async (method, contentType, outputFormat, meta) => {
  const audioBuffer = Buffer.from([1, 2, 3]);
  respond((url, init) => {
    expect(url).toBe("https://api.heygen.com/v3/models/audio/tts/stream");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("key");
    expect(JSON.parse(init?.body as string)).toEqual({
      text: "hi",
      voice_id: "83548de556df48ba8c09c42a57c51d85",
      model: "heygen-voice-1-turbo",
      output_format: outputFormat,
    });
    return new Response(audioBuffer, { headers: { "content-type": contentType } });
  });
  const result = await provider[method]?.({ ...request, target: "audio-file" });
  assert(result);
  expect(result).toMatchObject(meta);
  expect(
    "audioStream" in result ? await readAudio(result.audioStream) : result.audioBuffer,
  ).toEqual(audioBuffer);
});

it.each([
  [
    "directives over configured settings",
    { language: "fr", modelId: "heygen-voice-1-turbo-free", speakerVoiceId: "configured-voice" },
    { model: "heygen-voice-1", voiceId: "directive-voice" },
    { voice_id: "directive-voice", model: "heygen-voice-1", language: "fr" },
  ],
  [
    "a persona model",
    { model: "heygen-voice-1-turbo", modelId: "heygen-voice-1" },
    {},
    { model: "heygen-voice-1" },
  ],
  ["a speaker voice directive", {}, { voice: "named-voice" }, { voice_id: "named-voice" }],
])("applies %s", async (_name, providerConfig, providerOverrides, expected) => {
  respond((_url, init) => {
    expect(JSON.parse(init?.body as string)).toMatchObject(expected);
    return new Response(Buffer.from([1]), { headers: { "content-type": "audio/mpeg" } });
  });
  await provider.synthesize({
    ...request,
    providerConfig: { ...request.providerConfig, ...providerConfig },
    providerOverrides,
    target: "audio-file",
  });
});

it("keeps a long HTTP take alive while audio arrives", async () => {
  const { fetchWithSsrFGuard } = await vi.importActual<
    typeof import("openclaw/plugin-sdk/ssrf-runtime")
  >("openclaw/plugin-sdk/ssrf-runtime");
  fetchMock.mockImplementation((params: Parameters<typeof fetchWithSsrFGuard>[0]) =>
    fetchWithSsrFGuard({ ...params, policy: { allowPrivateNetwork: true } }),
  );
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "audio/mpeg" });
    let sent = 0;
    const timer = setInterval(() => {
      response.write(Buffer.from([++sent]));
      if (sent === 4) {
        clearInterval(timer);
        response.end();
      }
    }, 200);
  });
  const port = await listenOnLoopback(server);
  try {
    const result = await streamSpeech({ baseUrl: `http://127.0.0.1:${port}` }, { timeoutMs: 500 });
    expect(await readAudio(result.audioStream)).toEqual(Buffer.from([1, 2, 3, 4]));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

it("transcodes voice notes to Opus", async () => {
  respond(() => new Response(Buffer.from([1]), { headers: { "content-type": "audio/mpeg" } }));
  transcodeMock.mockResolvedValue(Buffer.from([9]));
  const result = await provider.synthesize({ ...request, target: "voice-note" });
  expect(result).toEqual({
    audioBuffer: Buffer.from([9]),
    outputFormat: "opus",
    fileExtension: ".opus",
    voiceCompatible: true,
  });
  expect(transcodeMock).toHaveBeenCalledWith(
    expect.objectContaining({ audioBuffer: Buffer.from([1]), inputExtension: "mp3" }),
  );
});

it("errors the stream past the configured media limit", async () => {
  respond(() => new Response(Buffer.from([1, 2]), { headers: { "content-type": "audio/mpeg" } }));
  const result = await streamSpeech(
    {},
    { cfg: { agents: { defaults: { mediaMaxMb: 1 / (1024 * 1024) } } } },
  );
  await expect(readAudio(result.audioStream)).rejects.toThrow("exceeds 1 bytes");
});

it("releases the request when playback stops", async () => {
  const release = vi.fn(async () => {});
  const response = new Response(new ReadableStream(), {
    headers: { "content-type": "audio/mpeg" },
  });
  fetchMock.mockResolvedValue({ response, release });
  const result = await streamSpeech({});
  await result.release?.();
  expect(release).toHaveBeenCalledOnce();
});

it("releases the request when HeyGen refuses a stream", async () => {
  const release = vi.fn(async () => {});
  fetchMock.mockResolvedValue({ response: new Response("no", { status: 503 }), release });
  await expect(streamSpeech({})).rejects.toThrow("503");
  expect(release).toHaveBeenCalledOnce();
});

const voice = (id: string, status = "ACTIVE") => ({
  voice_id: id,
  mode: "instant",
  name: id,
  language: "en",
  status,
});

it("lists every workspace page, then public voices that are ready", async () => {
  respond((url) => {
    const params = new URL(url).searchParams;
    if (params.get("type") === "public") {
      return Response.json({ data: [voice("public")], next_token: "more" });
    }
    return params.get("token") === "next"
      ? Response.json({ data: [voice("own-2")] })
      : Response.json({
          data: [voice("own-1"), voice("cloning", "PROCESSING")],
          next_token: "next",
        });
  });
  const voices = await provider.listVoices?.(request);
  expect(voices?.map(({ id }) => id)).toEqual(["own-1", "own-2", "public"]);
  expect(voices?.[0]).toEqual({ id: "own-1", name: "own-1", category: "instant", locale: "en" });
});

it("keeps workspace voices when the public list fails", async () => {
  respond((url) =>
    new URL(url).searchParams.get("type") === "public"
      ? new Response("unavailable", { status: 503 })
      : Response.json({ data: [voice("own")] }),
  );
  expect((await provider.listVoices?.(request))?.map(({ id }) => id)).toEqual(["own"]);
});

it.each([
  ["model", "heygen-voice-2", 'invalid HeyGen model "heygen-voice-2"'],
  ["apiKey", "   ", "HeyGen API key missing"],
])("rejects invalid %s before network access", async (key, value, error) => {
  vi.stubEnv("HEYGEN_API_KEY", "   ");
  const providerConfig = { ...request.providerConfig, [key]: value };
  if (key === "apiKey") {
    expect(await provider.isConfiguredAsync?.({ ...request, providerConfig })).toBe(false);
  }
  await expect(
    provider.synthesize({ ...request, providerConfig, target: "audio-file" }),
  ).rejects.toThrow(error);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("falls back to HEYGEN_API_KEY", async () => {
  vi.stubEnv("HEYGEN_API_KEY", "env-key");
  expect(await provider.isConfiguredAsync?.({ ...request, providerConfig: {} })).toBe(true);
});

it.each([
  ["voice", "v", { voiceId: "v" }],
  ["voiceid", "v", { voiceId: "v" }],
  ["voice_id", "v", { voiceId: "v" }],
  ["model", "heygen-voice-1", { model: "heygen-voice-1" }],
] as const)("accepts %s=%s directives", (key, value, overrides) => {
  const policy = createSpeechDirectivePolicy();
  expect(provider.parseDirectiveToken?.({ key, value, policy })).toEqual({
    handled: true,
    overrides,
  });
});

it("warns on an unknown model directive", () => {
  const policy = createSpeechDirectivePolicy();
  expect(provider.parseDirectiveToken?.({ key: "model", value: "nope", policy })).toEqual({
    handled: true,
    warnings: ['Error: invalid HeyGen model "nope"'],
  });
});

it("layers Talk settings over the base TTS config", () => {
  const baseTtsConfig = {
    providers: {
      heygen: {
        apiKey: "base-key",
        model: "heygen-voice-1",
        speakerVoiceId: "base-voice",
      },
    },
  };
  expect(
    provider.resolveTalkConfig?.({
      cfg: {},
      baseTtsConfig,
      talkProviderConfig: { voiceId: "talk-voice" },
      timeoutMs: 1_000,
    }),
  ).toMatchObject({ apiKey: "base-key", model: "heygen-voice-1", voiceId: "talk-voice" });
});

it("turns request settings into overrides", () => {
  const resolve = (params: Record<string, unknown>) =>
    provider.resolveTalkOverrides?.({ talkProviderConfig: {}, params });
  expect(resolve({ voiceId: "v", modelId: "heygen-voice-1" })).toEqual({
    voiceId: "v",
    model: "heygen-voice-1",
  });
  expect(resolve({ speed: 1.2 })).toBeUndefined();
});
