// Xai tests cover realtime transcription provider plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { createLazyXaiRealtimeTranscriptionProvider } from "./lazy-capability-provider-factories.js";

const { isProviderAuthProfileConfiguredAsyncMock, resolveApiKeyForProviderMock } = vi.hoisted(
  () => ({
    isProviderAuthProfileConfiguredAsyncMock: vi.fn(async () => false),
    resolveApiKeyForProviderMock: vi.fn<PluginCapabilityCatalogContext["resolveApiKeyForProvider"]>(
      async () => ({ apiKey: undefined, source: "test", mode: "oauth" }),
    ),
  }),
);

const transcriptionHost = {
  isProviderAuthProfileConfigured: () => false,
  isProviderAuthProfileConfiguredAsync: isProviderAuthProfileConfiguredAsyncMock,
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  createRealtimeTranscriptionWebSocketSession,
};

let provider: ReturnType<typeof createLazyXaiRealtimeTranscriptionProvider>;
beforeEach(() => {
  provider = createLazyXaiRealtimeTranscriptionProvider(transcriptionHost);
});
type SessionRequest = Parameters<typeof provider.createSession>[0];
function createSession(baseUrl: string, overrides: Partial<SessionRequest> = {}) {
  return provider.createSession({
    ...overrides,
    providerConfig: { apiKey: "xai-test-key", baseUrl, ...overrides.providerConfig },
  });
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  isProviderAuthProfileConfiguredAsyncMock.mockReset().mockResolvedValue(false);
  resolveApiKeyForProviderMock.mockReset().mockResolvedValue({
    apiKey: undefined,
    source: "test",
    mode: "oauth",
  });
  delete process.env.XAI_API_KEY;
  vi.unstubAllEnvs();
});

async function createRealtimeSttServer(params?: {
  onRequest?: (url: URL, headers: Record<string, string | string[] | undefined>) => void;
  onBinary?: (audio: Buffer) => void;
  initialEvent?: unknown;
  transcriptionEvents?: readonly Record<string, unknown>[];
}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const clients = new Set<WebSocket>();
  const done = vi.fn();
  const completion = createDeferred<void>();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    params?.onRequest?.(url, request.headers);
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.send(JSON.stringify(params?.initialEvent ?? { type: "transcript.created" }));
      ws.on("message", (data, isBinary) => {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        if (isBinary) {
          params?.onBinary?.(buffer);
          const events = params?.transcriptionEvents ?? [
            {
              type: "transcript.partial",
              text: "hello openclaw",
              is_final: false,
              speech_final: false,
            },
            {
              type: "transcript.partial",
              text: "hello openclaw final",
              is_final: true,
              speech_final: true,
            },
          ];
          for (const event of events) {
            ws.send(JSON.stringify(event));
          }
          return;
        }
        const event = JSON.parse(buffer.toString()) as { type?: string };
        if (event.type === "audio.done") {
          ws.send(JSON.stringify({ type: "transcript.done", text: "hello openclaw final" }));
          done();
          completion.resolve();
        }
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  cleanup = async () => {
    for (const ws of clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, done, donePromise: completion.promise };
}

describe("xai realtime transcription provider", () => {
  it("normalizes provider config for voice-call streaming", () => {
    const config = {
      apiKey: "xai-test-key",
      baseUrl: "https://api.x.ai/v1",
      sampleRate: 24000,
      encoding: "pcm",
      interimResults: false,
      endpointingMs: 500,
      language: "en",
    };
    expect(
      provider.resolveConfig?.({
        cfg: {} as never,
        rawConfig: { providers: { xai: config } },
      }),
    ).toEqual(config);
  });

  it("streams raw binary audio and maps partial and final transcript events", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const binaryFrames: Buffer[] = [];
    const requestUrls: URL[] = [];
    const upgradeHeaders: Array<Record<string, string | string[] | undefined>> = [];
    const server = await createRealtimeSttServer({
      onRequest: (url, headers) => {
        requestUrls.push(url);
        upgradeHeaders.push(headers);
      },
      onBinary: (audio) => binaryFrames.push(audio),
    });
    const onPartial = vi.fn();
    const finalTranscript = createDeferred<void>();
    const onTranscript = vi.fn((text: string) => {
      if (text === "hello openclaw final") {
        finalTranscript.resolve();
      }
    });
    const onSpeechStart = vi.fn();

    const session = createSession(server.baseUrl, {
      providerConfig: { sampleRate: 24000, encoding: "pcm", endpointingMs: 500 },
      onPartial,
      onTranscript,
      onSpeechStart,
    });

    session.sendAudio(Buffer.from("queued-before-ready"));
    await session.connect();
    session.sendAudio(Buffer.from("after-ready"));
    await finalTranscript.promise;
    session.close();
    await server.donePromise;

    expect(requestUrls[0]?.pathname).toBe("/v1/stt");
    expect(Object.fromEntries(requestUrls[0]!.searchParams)).toMatchObject({
      sample_rate: "24000",
      encoding: "pcm",
      interim_results: "true",
      endpointing: "500",
    });
    expect(upgradeHeaders[0]?.["user-agent"]).toBeUndefined();
    expect(upgradeHeaders[0]?.authorization).toBe("Bearer xai-test-key");
    expect(Buffer.concat(binaryFrames).toString()).toContain("queued-before-ready");
    expect(Buffer.concat(binaryFrames).toString()).toContain("after-ready");
    expect(onSpeechStart).toHaveBeenCalled();
    expect(onPartial).toHaveBeenCalledWith("hello openclaw");
    vi.unstubAllEnvs();
  });

  it("preserves identical final transcripts from separate speech turns", async () => {
    const server = await createRealtimeSttServer({
      transcriptionEvents: [
        { type: "transcript.partial", text: "yes", is_final: true, speech_final: true },
        { type: "transcript.partial", text: "yes", is_final: true, speech_final: true },
      ],
    });
    const onTranscript = vi.fn();
    const onSpeechStart = vi.fn();
    const session = createSession(server.baseUrl, {
      onTranscript,
      onSpeechStart,
    });

    await session.connect();
    session.sendAudio(Buffer.from("two speech turns"));
    await vi.waitFor(() => expect(onSpeechStart).toHaveBeenCalledTimes(2));
    session.close();
    await server.donePromise;

    expect(onTranscript.mock.calls).toEqual([["yes"], ["yes"]]);
  });

  it("rejects setup errors before the stream is ready", async () => {
    const server = await createRealtimeSttServer({
      initialEvent: {
        type: "error",
        error: {
          message: "Streaming ASR unavailable",
        },
      },
    });
    const onError = vi.fn();

    const session = createSession(server.baseUrl, { onError });

    await expect(session.connect()).rejects.toThrow("Streaming ASR unavailable");
    expect(session.isConnected()).toBe(false);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[0]).toEqual(new Error("Streaming ASR unavailable"));
  });

  it("reports configured when an xAI auth profile exists, even without env or config apiKey", async () => {
    delete process.env.XAI_API_KEY;
    isProviderAuthProfileConfiguredAsyncMock.mockResolvedValue(true);
    expect(await provider.isConfiguredAsync?.({ cfg: {}, providerConfig: {} })).toBe(true);
    expect(isProviderAuthProfileConfiguredAsyncMock).toHaveBeenCalledWith({
      provider: "xai",
      cfg: {},
    });
  });

  it("does not treat a blank environment api key as configured", async () => {
    vi.stubEnv("XAI_API_KEY", "   ");
    isProviderAuthProfileConfiguredAsyncMock.mockResolvedValue(false);

    expect(await provider.isConfiguredAsync?.({ cfg: {}, providerConfig: {} })).toBe(false);
  });

  it("threads cfg into the lazy WebSocket bearer resolver", async () => {
    delete process.env.XAI_API_KEY;
    resolveApiKeyForProviderMock.mockResolvedValue({
      apiKey: "oauth-bearer",
      source: "test",
      mode: "oauth",
    });
    const upgradeHeaders: Array<Record<string, string | string[] | undefined>> = [];
    const server = await createRealtimeSttServer({
      onRequest: (_url, headers) => {
        upgradeHeaders.push(headers);
      },
    });

    const cfg = { agents: { defaults: {} } };
    const session = provider.createSession({
      cfg,
      providerConfig: {
        baseUrl: server.baseUrl,
      },
    });

    await session.connect();
    session.close();
    await server.donePromise;

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({ provider: "xai", cfg });
    expect(upgradeHeaders[0]?.authorization).toBe("Bearer oauth-bearer");
  });
});
