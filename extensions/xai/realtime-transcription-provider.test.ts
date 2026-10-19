import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createLazyXaiRealtimeTranscriptionProvider } from "./lazy-capability-provider-factories.js";

const { profileAuth, resolveKey, authResult } = vi.hoisted(() => {
  const makeAuth = (apiKey?: string) => ({ apiKey, source: "test", mode: "oauth" as const });
  return {
    authResult: makeAuth,
    profileAuth: vi.fn(async () => false),
    resolveKey: vi.fn<PluginCapabilityCatalogContext["resolveApiKeyForProvider"]>(async () =>
      makeAuth(),
    ),
  };
});

const transcriptionHost = {
  isProviderAuthProfileConfigured: () => false,
  isProviderAuthProfileConfiguredAsync: profileAuth,
  resolveApiKeyForProvider: resolveKey,
  createRealtimeTranscriptionWebSocketSession,
};

const provider = createLazyXaiRealtimeTranscriptionProvider(transcriptionHost);
type SessionRequest = Parameters<typeof provider.createSession>[0];
function createSession(baseUrl: string, overrides: Partial<SessionRequest> = {}) {
  return provider.createSession({
    ...overrides,
    providerConfig: { apiKey: "xai-test-key", baseUrl, ...overrides.providerConfig },
  });
}

let cleanup: (() => Promise<void>) | undefined;

const transcript = (text: string, final = false) => ({
  type: "transcript.partial",
  text,
  is_final: final,
  speech_final: final,
});

function completed(register: (done: () => void) => void) {
  return new Promise<void>((resolve) => {
    register(resolve);
  });
}

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  profileAuth.mockReset().mockResolvedValue(false);
  resolveKey.mockReset().mockResolvedValue(authResult());
  delete process.env.XAI_API_KEY;
  vi.unstubAllEnvs();
});

async function createRealtimeSttServer(params?: {
  initialEvent?: unknown;
  transcriptionEvents?: readonly Record<string, unknown>[];
}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const requests: Array<{ url: URL; headers: import("node:http").IncomingHttpHeaders }> = [];
  const binaryFrames: Buffer[] = [];
  const completion = createDeferred<void>();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ url, headers: request.headers });
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.send(JSON.stringify(params?.initialEvent ?? { type: "transcript.created" }));
      ws.on("message", (data, isBinary) => {
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        if (isBinary) {
          binaryFrames.push(buffer);
          const events = params?.transcriptionEvents ?? [
            transcript("hello openclaw"),
            transcript("hello openclaw final", true),
          ];
          for (const event of events) {
            ws.send(JSON.stringify(event));
          }
          return;
        }
        const event = JSON.parse(buffer.toString()) as { type?: string };
        if (event.type === "audio.done") {
          ws.send(JSON.stringify({ type: "transcript.done", text: "hello openclaw final" }));
          completion.resolve();
        }
      });
    });
  });

  await completed((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  cleanup = async () => {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await completed((done) => wss.close(done));
    await completed((done) => server.close(done));
  };
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    binaryFrames,
    donePromise: completion.promise,
  };
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
    const server = await createRealtimeSttServer();
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

    const { url, headers } = server.requests[0]!;
    expect(url.pathname).toBe("/v1/stt");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      sample_rate: "24000",
      encoding: "pcm",
      interim_results: "true",
      endpointing: "500",
    });
    expect(headers["user-agent"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer xai-test-key");
    const audio = Buffer.concat(server.binaryFrames).toString();
    expect(audio).toContain("queued-before-ready");
    expect(audio).toContain("after-ready");
    expect(onSpeechStart).toHaveBeenCalled();
    expect(onPartial).toHaveBeenCalledWith("hello openclaw");
  });

  it("preserves identical final transcripts from separate speech turns", async () => {
    const server = await createRealtimeSttServer({
      transcriptionEvents: [transcript("yes", true), transcript("yes", true)],
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
      initialEvent: { type: "error", error: { message: "Streaming ASR unavailable" } },
    });
    const onError = vi.fn();

    const session = createSession(server.baseUrl, { onError });

    await expect(session.connect()).rejects.toThrow("Streaming ASR unavailable");
    expect(session.isConnected()).toBe(false);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[0]).toEqual(new Error("Streaming ASR unavailable"));
  });

  it.each([
    ["uses an auth profile without an environment key", undefined, true],
    ["rejects a blank environment key without an auth profile", "   ", false],
  ] as const)("%s", async (_name, key, configured) => {
    vi.stubEnv("XAI_API_KEY", key);
    profileAuth.mockResolvedValue(configured);
    expect(await provider.isConfiguredAsync?.({ cfg: {}, providerConfig: {} })).toBe(configured);
    expect(profileAuth).toHaveBeenCalledWith({ provider: "xai", cfg: {} });
  });

  it("threads cfg into the lazy WebSocket bearer resolver", async () => {
    resolveKey.mockResolvedValue(authResult("oauth-bearer"));
    const server = await createRealtimeSttServer();

    const cfg = { agents: { defaults: {} } };
    const session = provider.createSession({
      cfg,
      providerConfig: { baseUrl: server.baseUrl },
    });

    await session.connect();
    session.close();
    await server.donePromise;

    expect(resolveKey).toHaveBeenCalledWith({ provider: "xai", cfg });
    expect(server.requests[0]?.headers.authorization).toBe("Bearer oauth-bearer");
  });
});
