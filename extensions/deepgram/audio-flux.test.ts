import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { commandResult } from "../test-support/command-result.test-support.js";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { isDeepgramFluxModel } from "./audio-flux.js";
import plugin from "./index.js";

const runCommandBuffered = vi.hoisted(() =>
  vi.fn<typeof import("openclaw/plugin-sdk/process-runtime").runCommandBuffered>(),
);
const prepareWebSocket = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("openclaw/plugin-sdk/media-ffmpeg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-ffmpeg")>()),
  resolveFfmpegBin: () => "/usr/bin/ffmpeg",
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runCommandBuffered }));
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    openProviderWebSocket: async (params: Parameters<typeof actual.openProviderWebSocket>[0]) => {
      await prepareWebSocket();
      return await actual.openProviderWebSocket(params);
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];
const registerProvider = vi.fn<(provider: MediaUnderstandingProvider) => void>();
plugin.register(createTestPluginApi({ registerMediaUnderstandingProvider: registerProvider }));
const transcribeAudio = expectDefined(
  registerProvider.mock.calls[0]?.[0].transcribeAudio,
  "registered audio transcription callback",
);

async function createFluxServer(onFlush = (socket: WebSocket) => socket.close()) {
  const listener = createServer();
  const server = new WebSocketServer({ server: listener, maxPayload: 1024 * 1024 });
  const audioFrames: Buffer[] = [];
  const requests: Array<{ url: URL; headers: Record<string, string | string[] | undefined> }> = [];
  listener.on("upgrade", (request) => {
    requests.push({
      url: new URL(request.url ?? "/", "http://127.0.0.1"),
      headers: request.headers,
    });
  });
  server.on("connection", (client) => {
    client.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (isBinary) {
        audioFrames.push(bytes);
      } else if (asOptionalRecord(JSON.parse(bytes.toString()))?.type === "CloseStream") {
        onFlush(client);
      }
    });
  });
  const port = await listenOnLoopback(listener);
  cleanups.push(
    async () =>
      await new Promise<void>((resolve, reject) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => listener.close((error) => (error ? reject(error) : resolve())));
      }),
  );
  return {
    audioFrames,
    requests,
    transcribe: (extra: Partial<AudioTranscriptionRequest> = {}) =>
      transcribeAudio({
        buffer: Buffer.from("source audio"),
        fileName: "note.ogg",
        apiKey: "default-key",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "flux-general-multi",
        timeoutMs: 5000,
        request: { allowPrivateNetwork: true },
        ...extra,
      }),
  };
}

function turn(transcript?: unknown): string {
  return JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", transcript });
}

async function writeDecodedPcm(argv: string[], pcm: Buffer) {
  await writeFile(expectDefined(argv.at(-1), "decoder output path"), pcm);
  return {
    ...commandResult(),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    termination: "exit" as const,
  };
}

describe("Deepgram Flux audio", () => {
  beforeEach(() => {
    runCommandBuffered.mockImplementationOnce((argv) => writeDecodedPcm(argv, Buffer.alloc(10, 1)));
  });
  afterEach(async () => {
    runCommandBuffered.mockReset();
    prepareWebSocket.mockReset();
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("keeps decoding, connection preparation, and transcription within one deadline", async () => {
    const flushed = createDeferred<void>();
    const server = await createFluxServer(() => flushed.resolve());
    runCommandBuffered.mockReset().mockImplementationOnce(async (argv) => {
      await vi.advanceTimersByTimeAsync(200);
      return await writeDecodedPcm(argv, Buffer.alloc(10, 1));
    });
    prepareWebSocket.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const errors: unknown[] = [];
    const transcription = server
      .transcribe({ timeoutMs: 1000 })
      .catch((error: unknown) => errors.push(error));
    await flushed.promise;
    await vi.advanceTimersByTimeAsync(499);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await transcription;
    expect(errors).toEqual([expect.any(Error)]);
    expect(errors[0]).toMatchObject({ message: expect.stringContaining("timed out") });
  });

  it("routes documented Flux models only", () => {
    expect(isDeepgramFluxModel("flux-general-en")).toBe(true);
    expect(isDeepgramFluxModel(" Flux-General-Multi ")).toBe(true);
    expect(isDeepgramFluxModel("flux")).toBe(false);
    expect(isDeepgramFluxModel("reflux-general-en")).toBe(false);
    expect(isDeepgramFluxModel("nova-3")).toBe(false);
  });

  it.each([
    { model: "flux-general-multi", language: " en ", hint: undefined, expected: "en" },
    { model: "flux-general-multi", language: "en", hint: "fr", expected: "fr" },
    { model: "flux-general-en", language: " en ", hint: "fr", expected: null },
  ])("sends $model protocol (hint=$hint)", async ({ model, language, hint, expected }) => {
    const pcm = Buffer.alloc(6000, 1);
    runCommandBuffered.mockReset().mockImplementationOnce((argv) => writeDecodedPcm(argv, pcm));
    const server = await createFluxServer((socket) => {
      socket.send(turn("life moves"));
      socket.send(turn("pretty fast"));
      socket.close();
    });

    const result = await server.transcribe({
      model,
      language,
      query: {
        ...(hint === undefined ? {} : { language_hint: hint }),
        eot_threshold: 0.7,
        keyterm: ["OpenClaw", "Deepgram"],
        numerals: true,
        profanity_filter: true,
        smart_format: true,
      },
      request: {
        allowPrivateNetwork: true,
        auth: { mode: "header", headerName: "authorization", value: "Token configured-key" },
      },
    });

    const { url: requestUrl, headers } = expectDefined(server.requests[0], "Flux request");
    expect(result).toEqual({ model, text: "life moves pretty fast" });
    expect(headers.authorization).toBe("Token configured-key");
    expect(requestUrl.pathname).toBe("/v2/listen");
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      encoding: "linear16",
      sample_rate: "16000",
      eot_threshold: "0.7",
      numerals: "true",
      profanity_filter: "true",
    });
    expect(requestUrl.searchParams.get("language_hint")).toBe(expected);
    expect(requestUrl.searchParams.getAll("keyterm")).toEqual(["OpenClaw", "Deepgram"]);
    expect(requestUrl.searchParams.has("smart_format")).toBe(false);
    expect(server.audioFrames.map((frame) => frame.byteLength)).toEqual([2560, 2560, 880]);
    expect(Buffer.concat(server.audioFrames)).toEqual(pcm);
  });

  it("returns an empty transcript when the flushed stream has no turns", async () => {
    const server = await createFluxServer();
    await expect(server.transcribe()).resolves.toMatchObject({ text: "" });
  });

  it.each([
    ["non-object server JSON", "[]", "malformed JSON response"],
    ["a turn without transcript text", turn(), "missing transcript"],
    ["a turn with a non-string transcript", turn(42), "missing transcript"],
    ["oversized transcript", turn("x".repeat(256 * 1024 + 1)), "transcript exceeds size limit"],
  ])("rejects %s", async (_name, payload, error) => {
    const server = await createFluxServer((socket) => socket.send(payload));
    await expect(server.transcribe()).rejects.toThrow(error);
  });

  it("does not open a private socket without the request-policy opt-in", async () => {
    const server = await createFluxServer(() => undefined);
    await expect(server.transcribe({ request: { allowPrivateNetwork: false } })).rejects.toThrow(
      /private|loopback|blocked/iu,
    );
    expect(server.requests).toEqual([]);
  });
});
