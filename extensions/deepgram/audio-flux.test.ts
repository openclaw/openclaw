import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { isDeepgramFluxModel } from "./audio-flux.js";
import plugin from "./index.js";

const runCommandBuffered = vi.hoisted(() =>
  vi.fn<typeof import("openclaw/plugin-sdk/process-runtime").runCommandBuffered>(),
);
const prepareWebSocket = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
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
const registeredProviders: MediaUnderstandingProvider[] = [];
plugin.register(
  createTestPluginApi({
    registerMediaUnderstandingProvider: (provider) => registeredProviders.push(provider),
  }),
);
const transcribeAudio = expectDefined(
  registeredProviders[0]?.transcribeAudio,
  "registered audio transcription callback",
);

function parseClientMessage(data: RawData): Record<string, unknown> | undefined {
  if (typeof data !== "string" && !Buffer.isBuffer(data)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(data.toString());
  return asOptionalRecord(parsed);
}

async function createFluxServer(params: {
  onCloseStream: (socket: WebSocket) => void;
  onRequest?: (url: URL, headers: Record<string, string | string[] | undefined>) => void;
}) {
  const server = createServer();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const audioFrames: Buffer[] = [];
  server.on("upgrade", (request, socket, head) => {
    params.onRequest?.(new URL(request.url ?? "/", "http://127.0.0.1"), request.headers);
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data);
          audioFrames.push(bytes);
          return;
        }
        if (parseClientMessage(data)?.type === "CloseStream") {
          params.onCloseStream(client);
        }
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  cleanups.push(
    async () =>
      await new Promise<void>((resolve, reject) => {
        for (const client of websocketServer.clients) {
          client.terminate();
        }
        websocketServer.close(() => server.close((error) => (error ? reject(error) : resolve())));
      }),
  );
  return { audioFrames, baseUrl: `http://127.0.0.1:${port}/v1` };
}

function fluxRequest(
  baseUrl: string,
  extra: Partial<AudioTranscriptionRequest> = {},
): AudioTranscriptionRequest {
  return {
    buffer: Buffer.from("source audio"),
    fileName: "note.ogg",
    apiKey: "default-key",
    baseUrl,
    model: "flux-general-multi",
    timeoutMs: 5000,
    request: { allowPrivateNetwork: true },
    ...extra,
  };
}

async function writeDecodedPcm(argv: string[], pcm: Buffer) {
  await writeFile(expectDefined(argv.at(-1), "decoder output path"), pcm);
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

function mockDecodedPcm(pcm: Buffer): void {
  runCommandBuffered.mockImplementationOnce((argv) => writeDecodedPcm(argv, pcm));
}

describe("Deepgram Flux audio", () => {
  afterEach(async () => {
    runCommandBuffered.mockReset();
    prepareWebSocket.mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("keeps decoding, connection preparation, and transcription within one deadline", async () => {
    const decodeStarted = createDeferred<void>();
    const releaseDecode = createDeferred<void>();
    const preparationStarted = createDeferred<void>();
    const releasePreparation = createDeferred<void>();
    const flushed = createDeferred<void>();
    const server = await createFluxServer({ onCloseStream: () => flushed.resolve() });
    runCommandBuffered.mockImplementationOnce(async (argv) => {
      decodeStarted.resolve();
      await releaseDecode.promise;
      return await writeDecodedPcm(argv, Buffer.alloc(10, 1));
    });
    prepareWebSocket.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      await releasePreparation.promise;
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let failure: unknown;
    const transcription = transcribeAudio(fluxRequest(server.baseUrl, { timeoutMs: 1000 })).catch(
      (error: unknown) => {
        failure = error;
      },
    );

    await decodeStarted.promise;
    await vi.advanceTimersByTimeAsync(200);
    releaseDecode.resolve();
    await preparationStarted.promise;
    await vi.advanceTimersByTimeAsync(300);
    releasePreparation.resolve();
    await flushed.promise;
    await vi.advanceTimersByTimeAsync(499);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await transcription;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: expect.stringContaining("timed out") });
  });

  it("routes documented Flux models only", () => {
    expect(isDeepgramFluxModel("flux-general-en")).toBe(true);
    expect(isDeepgramFluxModel(" Flux-General-Multi ")).toBe(true);
    expect(isDeepgramFluxModel("flux")).toBe(false);
    expect(isDeepgramFluxModel("reflux-general-en")).toBe(false);
    expect(isDeepgramFluxModel("nova-3")).toBe(false);
  });

  it.each([
    { model: "flux-general-multi", language: " en ", queryLanguage: undefined, expectedHint: "en" },
    { model: "flux-general-multi", language: "en", queryLanguage: "fr", expectedHint: "fr" },
    { model: "flux-general-en", language: " en ", queryLanguage: undefined, expectedHint: null },
    { model: "flux-general-en", language: undefined, queryLanguage: "en", expectedHint: null },
  ])(
    "uses valid protocol fields for $model with language=$language and query=$queryLanguage",
    async ({ model, language, queryLanguage, expectedHint }) => {
      const pcm = Buffer.alloc(6000, 1);
      mockDecodedPcm(pcm);
      let requestUrl: URL | undefined;
      let authorization: string | string[] | undefined;
      const server = await createFluxServer({
        onRequest: (url, headers) => {
          requestUrl = url;
          authorization = headers.authorization;
        },
        onCloseStream: (socket) => {
          socket.send(
            JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", transcript: "life moves" }),
          );
          socket.send(
            JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", transcript: "pretty fast" }),
          );
          socket.close();
        },
      });

      const result = await transcribeAudio(
        fluxRequest(server.baseUrl, {
          model,
          language,
          query: {
            ...(queryLanguage === undefined ? {} : { language_hint: queryLanguage }),
            eot_threshold: 0.7,
            numerals: true,
            profanity_filter: true,
            smart_format: true,
          },
          request: {
            allowPrivateNetwork: true,
            auth: {
              mode: "header",
              headerName: "authorization",
              value: "Token configured-key",
            },
          },
        }),
      );

      expect(result).toEqual({ model, text: "life moves pretty fast" });
      expect(authorization).toBe("Token configured-key");
      expect(requestUrl?.pathname).toBe("/v2/listen");
      expect(requestUrl?.searchParams.get("encoding")).toBe("linear16");
      expect(requestUrl?.searchParams.get("sample_rate")).toBe("16000");
      expect(requestUrl?.searchParams.get("language_hint")).toBe(expectedHint);
      expect(requestUrl?.searchParams.get("eot_threshold")).toBe("0.7");
      expect(requestUrl?.searchParams.get("numerals")).toBe("true");
      expect(requestUrl?.searchParams.get("profanity_filter")).toBe("true");
      expect(requestUrl?.searchParams.has("smart_format")).toBe(false);
      expect(server.audioFrames.map((frame) => frame.byteLength)).toEqual([2560, 2560, 880]);
      expect(Buffer.concat(server.audioFrames)).toEqual(pcm);
    },
  );

  it.each(["null", "[]", "42"])("rejects valid non-object server JSON: %s", async (payload) => {
    mockDecodedPcm(Buffer.alloc(10, 1));
    const server = await createFluxServer({
      onCloseStream: (socket) => socket.send(payload),
    });
    await expect(transcribeAudio(fluxRequest(server.baseUrl))).rejects.toThrow(
      "malformed JSON response",
    );
  });

  it("rejects retained transcript growth above the provider limit", async () => {
    mockDecodedPcm(Buffer.alloc(10, 1));
    const server = await createFluxServer({
      onCloseStream: (socket) =>
        socket.send(
          JSON.stringify({
            type: "TurnInfo",
            event: "EndOfTurn",
            transcript: "x".repeat(256 * 1024 + 1),
          }),
        ),
    });
    await expect(transcribeAudio(fluxRequest(server.baseUrl))).rejects.toThrow(
      "transcript exceeds size limit",
    );
  });

  it("does not open a private socket without the request-policy opt-in", async () => {
    mockDecodedPcm(Buffer.alloc(10, 1));
    let opened = false;
    const server = await createFluxServer({
      onRequest: () => {
        opened = true;
      },
      onCloseStream: () => undefined,
    });
    await expect(
      transcribeAudio(fluxRequest(server.baseUrl, { request: { allowPrivateNetwork: false } })),
    ).rejects.toThrow(/private|loopback|blocked/iu);
    expect(opened).toBe(false);
  });
});
