import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/realtime-voice-provider";
import { afterAll, afterEach, assert, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
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
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    openProviderWebSocket: (params: Parameters<typeof actual.openProviderWebSocket>[0]) =>
      actual.openProviderWebSocket({ ...params, allowPrivateNetwork: true }),
  };
});

function respond(handler: (url: string, init?: RequestInit) => Response) {
  fetchMock.mockImplementation(async ({ url, init }: { url: string; init?: RequestInit }) => ({
    response: handler(url, init),
    release: async () => {},
  }));
}

const closers: Array<() => Promise<void>> = [];

async function serve(listener: Server): Promise<string> {
  const port = await listenOnLoopback(listener);
  closers.push(async () => {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  });
  return `http://127.0.0.1:${port}`;
}

async function createSpeechServer(speak: (client: WebSocket) => void) {
  const listener = createServer();
  const sockets = new WebSocketServer({ server: listener });
  const frames: unknown[] = [];
  const upgrades: Array<{ url: URL; headers: IncomingHttpHeaders }> = [];
  listener.on("upgrade", ({ url, headers }) =>
    upgrades.push({ url: new URL(url ?? "/", "http://127.0.0.1"), headers }),
  );
  sockets.on("connection", (client) => {
    client.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as { text: string };
      frames.push(frame);
      if (!frame.text) {
        speak(client);
      }
    });
  });
  closers.push(async () => sockets.clients.forEach((client) => client.terminate()));
  return { baseUrl: await serve(listener), frames, upgrades };
}

const audio = (...bytes: number[]) =>
  JSON.stringify({ audio: Buffer.from(bytes).toString("base64") });
const finalFrame = JSON.stringify({ audio: null, isFinal: true });
const errorFrame = JSON.stringify({
  message: "Voice not found",
  error: { code: "voice_not_found", message: "Voice not found", request_id: "req-1" },
});

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

async function streamOverSocket(speak: (client: WebSocket) => void, extra = {}) {
  const { baseUrl } = await createSpeechServer(speak);
  return await streamSpeech({ baseUrl, streamTransport: "websocket" }, extra);
}

const readAudio = async (stream: ReadableStream<Uint8Array>) =>
  Buffer.from(await new Response(stream).arrayBuffer());

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("openclaw/plugin-sdk/media-runtime");
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.resetModules();
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  fetchMock.mockReset();
  transcodeMock.mockReset();
  vi.unstubAllEnvs();
});

const diagnosticMethods = [
  "synthesize",
  "streamSynthesize",
  "synthesizeTelephony",
  "listVoices",
] as const;
it.each(diagnosticMethods)("redacts %s diagnostics and keeps the code", async (operation) => {
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
});

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
    expect(JSON.parse(String(init?.body))).toEqual({
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

it("applies configured settings, with directives taking precedence", async () => {
  respond((_url, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({
      voice_id: "directive-voice",
      model: "heygen-voice-1",
      language: "fr",
    });
    return new Response(Buffer.from([1]), { headers: { "content-type": "audio/mpeg" } });
  });
  await provider.synthesize({
    ...request,
    providerConfig: {
      apiKey: "key",
      language: "fr",
      modelId: "heygen-voice-1-turbo-free",
      speakerVoiceId: "configured-voice",
    },
    providerOverrides: { model: "heygen-voice-1", voiceId: "directive-voice" },
    target: "audio-file",
  });
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

it("streams one complete text over the socket", async () => {
  const { baseUrl, frames, upgrades } = await createSpeechServer((client) => {
    client.send(audio(1, 2));
    client.send(audio(3));
    client.send(finalFrame);
  });
  const result = await streamSpeech({
    baseUrl,
    language: "en",
    model: "heygen-voice-1",
    streamTransport: "websocket",
    voiceId: "v",
  });
  expect(result).toMatchObject(mp3Result);
  expect(await readAudio(result.audioStream)).toEqual(Buffer.from([1, 2, 3]));
  expect(frames).toEqual([{ text: "hi" }, { text: "" }]);
  const upgrade = upgrades[0];
  assert(upgrade);
  expect(upgrade.url.pathname).toBe("/v3/models/audio/tts/stream-input");
  expect(upgrade.headers["x-api-key"]).toBe("key");
  expect(Object.fromEntries(upgrade.url.searchParams)).toEqual({
    language: "en",
    model: "heygen-voice-1",
    output_format: "mp3_44100_128",
    voice_id: "v",
  });
});

it.each([
  [
    "an error frame",
    (client: WebSocket) => {
      client.send(errorFrame);
      client.close(1008);
    },
    "HeyGen TTS API error: Voice not found [code=voice_not_found] [request_id=req-1]",
  ],
  ["a capacity close", (client: WebSocket) => client.close(1013, "busy"), "(1013): busy"],
  ["an empty result", (client: WebSocket) => client.send(finalFrame), "returned no audio"],
  [
    "malformed audio",
    (client: WebSocket) => client.send(JSON.stringify({ audio: "%%%" })),
    "malformed base64",
  ],
  ["a non-JSON frame", (client: WebSocket) => client.send("nope"), "JSON"],
])("rejects %s before audio so core can fall back", async (_name, speak, message) => {
  await expect(streamOverSocket(speak)).rejects.toThrow(message);
});

it("rejects a silent socket at the timeout", async () => {
  await expect(streamOverSocket(() => {}, { timeoutMs: 20 })).rejects.toThrow("timed out");
});

it("keeps the code and request id from a refused handshake", async () => {
  const body = JSON.stringify({
    error: { code: "rate_limit_exceeded", message: "Too many requests" },
  });
  const listener = createServer();
  listener.on("upgrade", (_request, socket) => {
    socket.end(
      [
        "HTTP/1.1 429 Too Many Requests",
        "content-type: application/json",
        `content-length: ${body.length}`,
        "x-request-id: req-2",
        "connection: close",
        "",
        body,
      ].join("\r\n"),
    );
  });
  const baseUrl = await serve(listener);
  await expect(streamSpeech({ baseUrl, streamTransport: "websocket" })).rejects.toMatchObject({
    message:
      "HeyGen TTS API error (429): Too many requests [code=rate_limit_exceeded] [request_id=req-2]",
    status: 429,
  });
});

it.each([
  ["drops", (client: WebSocket) => client.terminate(), "closed before final audio (1006)"],
  ["sends an error", (client: WebSocket) => client.send(errorFrame), "voice_not_found"],
])("errors the stream when the socket %s after audio", async (_name, fail, message) => {
  const result = await streamOverSocket((client) => {
    client.send(audio(1));
    fail(client);
  });
  await expect(readAudio(result.audioStream)).rejects.toThrow(message);
});

it("errors the stream past the configured media limit", async () => {
  const result = await streamOverSocket(
    (client) => {
      client.send(audio(1));
      client.send(audio(2));
    },
    { cfg: { agents: { defaults: { mediaMaxMb: 1 / (1024 * 1024) } } } },
  );
  await expect(readAudio(result.audioStream)).rejects.toThrow("exceeds 1 bytes");
});

it("closes the socket on release", async () => {
  const closed = createDeferred<number>();
  const result = await streamOverSocket((client) => {
    client.once("close", closed.resolve);
    client.send(audio(1));
  });
  await result.release?.();
  await closed.promise;
  expect(await readAudio(result.audioStream)).toEqual(Buffer.from([1]));
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
      return Response.json({ data: [voice("public")], has_more: true, next_token: "more" });
    }
    return params.get("token") === "next"
      ? Response.json({ data: [voice("own-2")], has_more: false })
      : Response.json({
          data: [voice("own-1"), voice("cloning", "PROCESSING")],
          has_more: true,
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
      : Response.json({ data: [voice("own")], has_more: false }),
  );
  expect((await provider.listVoices?.(request))?.map(({ id }) => id)).toEqual(["own"]);
});

it.each([
  ["model", "heygen-voice-2", 'invalid HeyGen model "heygen-voice-2"'],
  ["streamTransport", "carrier-pigeon", 'invalid HeyGen streamTransport "carrier-pigeon"'],
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
  ["voice_id", "v", { voiceId: "v" }],
  ["model", "heygen-voice-1", { model: "heygen-voice-1" }],
] as const)("accepts %s=%s directives", (key, value, overrides) => {
  const policy = createSpeechDirectivePolicy();
  expect(provider.parseDirectiveToken?.({ key, value, policy })).toEqual({
    handled: true,
    overrides,
  });
});
