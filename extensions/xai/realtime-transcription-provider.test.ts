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

function observeText(matches: (text: string) => boolean) {
  const done = createDeferred<void>();
  const callback = vi.fn((text: string) => {
    if (matches(text)) {
      done.resolve();
    }
  });
  return { callback, done: done.promise };
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
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 16 * 1024 * 1024 });
  const requests: Array<{ url: URL; headers: import("node:http").IncomingHttpHeaders }> = [];
  const binaryFrames: Buffer[] = [];
  const completion = createDeferred<void>();

  wss.on("connection", (ws, request) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ url, headers: request.headers });
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

  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });
  const port = (wss.address() as AddressInfo).port;
  cleanup = async () => {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    binaryFrames,
    donePromise: completion.promise,
  };
}

describe("xai realtime transcription provider", () => {
  it.each(["direct", "profile"])(
    "streams binary audio and transcripts with %s auth",
    async (auth) => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
      resolveKey.mockResolvedValue(authResult("oauth-bearer"));
      const server = await createRealtimeSttServer();
      const onPartial = vi.fn();
      const final = observeText((text) => text === "hello openclaw final");
      const onSpeechStart = vi.fn();
      const cfg = { agents: { defaults: {} } };
      const config = {
        apiKey: auth === "direct" ? "xai-test-key" : undefined,
        baseUrl: server.baseUrl,
        sampleRate: 24000,
        encoding: "pcm",
        interimResults: auth === "profile" ? false : undefined,
        endpointingMs: 500,
        language: "en",
      };
      expect(provider.resolveConfig?.({ cfg, rawConfig: { providers: { xai: config } } })).toEqual(
        config,
      );
      const session = createSession(server.baseUrl, {
        cfg,
        providerConfig: config,
        onPartial,
        onTranscript: final.callback,
        onSpeechStart,
      });

      session.sendAudio(Buffer.from("queued-before-ready"));
      await session.connect();
      session.sendAudio(Buffer.from("after-ready"));
      await final.done;
      session.close();
      await server.donePromise;

      const { url, headers } = server.requests[0]!;
      expect(url.pathname).toBe("/v1/stt");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        sample_rate: "24000",
        encoding: "pcm",
        interim_results: auth === "profile" ? "false" : "true",
        endpointing: "500",
        language: "en",
      });
      expect(headers["user-agent"]).toBeUndefined();
      expect(headers.authorization).toBe(
        auth === "direct" ? "Bearer xai-test-key" : "Bearer oauth-bearer",
      );
      if (auth === "profile") {
        expect(resolveKey).toHaveBeenCalledWith({ provider: "xai", cfg });
      }
      expect(Buffer.concat(server.binaryFrames).toString()).toBe("queued-before-readyafter-ready");
      expect(onSpeechStart).toHaveBeenCalled();
      expect(onPartial).toHaveBeenCalledWith("hello openclaw");
    },
  );

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
  });
});

describe("xai chunk-final retention", () => {
  it("keeps successive chunks and emits stitched finals without duplication", async () => {
    const server = await createRealtimeSttServer({
      transcriptionEvents: [
        transcript("First."),
        { ...transcript("First.", true), speech_final: false },
        transcript("Second."),
        { ...transcript("Second.", true), speech_final: false },
        transcript("Third."),
        transcript("First. Second. Third.", true),
        transcript("Next turn."),
        transcript("Next turn.", true),
        transcript("Next turn.", true),
      ],
    });
    const onPartial = vi.fn();
    const onSpeechStart = vi.fn();
    let repeatedFinals = 0;
    const final = observeText((text) => text === "Next turn." && ++repeatedFinals === 2);
    const onTranscript = final.callback;
    const session = createSession(server.baseUrl, { onPartial, onTranscript, onSpeechStart });
    await session.connect();
    session.sendAudio(Buffer.from("audio"));
    await final.done;
    expect(onPartial.mock.calls).toEqual([
      ["First."],
      ["First."],
      ["First. Second."],
      ["First. Second."],
      ["First. Second. Third."],
      ["Next turn."],
    ]);
    expect(onTranscript.mock.calls).toEqual([
      ["First. Second. Third."],
      ["Next turn."],
      ["Next turn."],
    ]);
    expect(onSpeechStart).toHaveBeenCalledTimes(3);
    session.close();
    await server.donePromise;
  });

  it("settles locked chunks before replacement-stream partials arrive", async () => {
    const events = [
      { ...transcript("Locked.", true), speech_final: false },
      transcript("unfinished"),
    ];
    const server = await createRealtimeSttServer({ transcriptionEvents: events });
    const partial = observeText((text) => text.endsWith("unfinished"));
    const final = observeText((text) => text === "New stream.");
    const onPartial = partial.callback;
    const onTranscript = final.callback;
    const session = createSession(server.baseUrl, { onPartial, onTranscript });
    await session.connect();
    session.sendAudio(Buffer.from("first stream"));
    await partial.done;
    events.splice(0, events.length, transcript("New stream."), transcript("New stream.", true));
    await session.connect();
    expect(onTranscript.mock.calls).toEqual([["Locked."]]);
    session.sendAudio(Buffer.from("replacement stream"));
    await final.done;
    expect(onPartial).toHaveBeenLastCalledWith("New stream.");
    expect(onTranscript.mock.calls).toEqual([["Locked."], ["New stream."]]);
    session.close();
    await server.donePromise;
  });
});
