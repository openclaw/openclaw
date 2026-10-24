import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const provider = buildMistralRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
});
let cleanup: (() => Promise<void>) | undefined;
const delta = (text: string) => ({ type: "transcription.text.delta", text });
const done = (text?: string) => ({ type: "transcription.done", text });
const segment = (text: string, start = 0, speaker_id?: string) => ({
  type: "transcription.segment",
  text,
  start,
  end: start + 1,
  speaker_id,
});
const texts = (callback: ReturnType<typeof vi.fn>) => callback.mock.calls.map(([text]) => text);

function createSession(
  baseUrl: string,
  callbacks: Omit<Parameters<typeof provider.createSession>[0], "providerConfig">,
) {
  return provider.createSession({
    providerConfig: { apiKey: "fixture-value", baseUrl },
    ...callbacks,
  });
}

async function terminalSession(events: Record<string, unknown>[]) {
  const { baseUrl, closed } = await createRealtimeServer([events]);
  const onPartial = vi.fn();
  const onTranscript = vi.fn();
  const onError = vi.fn();
  const session = createSession(baseUrl, { onPartial, onTranscript, onError });
  await session.connect();
  await withTimeout(closed, 1_000, { message: "Mistral terminal socket did not close" });
  expect(session.isConnected()).toBe(false);
  return { onPartial, onTranscript, onError };
}

async function createRealtimeServer(
  eventsByConnection: readonly (readonly Record<string, unknown>[])[] = [[]],
  onConnection?: (socket: WebSocket) => void,
) {
  const requests: URL[] = [];
  const closed = createDeferred<void>();
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let connectionCount = 0;
  server.on("upgrade", (request, socket, head) => {
    requests.push(new URL(request.url ?? "/", "http://127.0.0.1"));
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connectionIndex = connectionCount++;
      onConnection?.(ws);
      ws.on("close", () => closed.resolve());
      ws.on("message", (data) => {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        const message = JSON.parse(bytes.toString("utf8")) as { type?: unknown };
        if (message.type === "session.update") {
          for (const event of eventsByConnection[connectionIndex] ?? []) {
            ws.send(JSON.stringify(event));
          }
        }
      });
      ws.send(JSON.stringify({ type: "session.created" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup = async () => {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return {
    requests,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    closed: closed.promise,
  };
}

describe("buildMistralRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          mistral: {
            apiKey: "  sk-\r\nmistral│  ",
            model: "voxtral-mini-transcribe-realtime-2602",
            encoding: "g711_ulaw",
            sample_rate: "8000",
            target_streaming_delay_ms: "240",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-mistral",
      baseUrl: undefined,
      model: "voxtral-mini-transcribe-realtime-2602",
      encoding: "pcm_mulaw",
      sampleRate: 8000,
      targetStreamingDelayMs: 240,
    });
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("MISTRAL_API_KEY", "");
    expect(() => provider.createSession({ providerConfig: {} })).toThrow("Mistral API key missing");
  });

  it("connects through the public session boundary with the configured URL params", async () => {
    const { baseUrl, requests } = await createRealtimeServer();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "fixture-value",
        baseUrl,
        model: "voxtral-mini-transcribe-realtime-2602",
        sampleRate: 8000,
        encoding: "pcm_mulaw",
        targetStreamingDelayMs: 800,
      },
    });

    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/audio/transcriptions/realtime");
    expect(requests[0]?.searchParams.get("model")).toBe("voxtral-mini-transcribe-realtime-2602");
    expect(requests[0]?.searchParams.get("target_streaming_delay_ms")).toBe("800");
  });

  it.each<[string, Record<string, unknown>[], string[], string[]]>([
    ["terminal-only text", [done("final transcript")], [], ["final transcript"]],
    ["corrected final", [delta("a"), delta("b"), done("c")], ["a", "ab"], ["c"]],
    ["segment dedup", [delta("a"), segment("b"), done("b")], ["a"], ["b"]],
    [
      "identical independently timed segments",
      [segment("echo", 0, "first"), segment("echo", 1, "second"), done("echo echo")],
      [],
      ["echo", "echo"],
    ],
    [
      "flushes post-segment deltas without aggregate replay",
      [delta("hello"), segment("hello"), delta(" new"), delta(" speech"), done("hello new speech")],
      ["hello", " new", " new speech"],
      ["hello", " new speech"],
    ],
    ["aggregate rewrite", [segment("a"), segment("b", 1), done("c")], [], ["a", "b"]],
  ])("%s", async (_name, events, partials, transcripts) => {
    const { onPartial, onTranscript } = await terminalSession(events);
    expect(texts(onTranscript)).toEqual(transcripts);
    expect(texts(onPartial)).toEqual(partials);
  });

  it.each<[string, string, string, string[]]>([
    ["whitespace", "  \t", "hello  ", ["hello"]],
    ["period", ".", "hello.", ["hello"]],
    ["multilingual speech", ", 你好", "hello, 你好", ["hello", ", 你好"]],
    ["numbers", " 42", "hello 42", ["hello", " 42"]],
  ])("filters post-segment %s", async (_name, pending, aggregate, transcripts) => {
    const { onPartial, onTranscript } = await terminalSession([
      segment("hello"),
      delta(pending),
      done(aggregate),
    ]);
    expect(onPartial).toHaveBeenCalledExactlyOnceWith(pending);
    expect(texts(onTranscript)).toEqual(transcripts);
  });

  it.each<[string, string[], string[]]>([
    ["terminal-only speech", [], []],
    ["isolates interrupted partials", ["old fragment "], ["new fragment"]],
  ])("%s after a real provider reconnect", async (_name, firstPartials, nextPartials) => {
    let firstSocket: WebSocket | undefined;
    const { baseUrl, requests } = await createRealtimeServer(
      [
        [{ type: "transcription.segment", text: "earlier turn" }, ...firstPartials.map(delta)],
        [...nextPartials.map(delta), done("replacement final")],
      ],
      (socket) => {
        firstSocket ??= socket;
      },
    );
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const session = createSession(baseUrl, { onPartial, onTranscript, onError });

    try {
      await session.connect();
      await vi.waitFor(() => {
        expect(texts(onTranscript)).toEqual(["earlier turn"]);
        expect(texts(onPartial)).toEqual(firstPartials);
      });
      if (!firstSocket) {
        throw new Error("Mistral fixture did not establish its first WebSocket");
      }
      vi.useFakeTimers();
      firstSocket.terminate();
      // The real close must arm the retry before its backoff clock advances.
      await vi.waitFor(() => expect(session.isConnected()).toBe(false));
      await vi.advanceTimersByTimeAsync(1_000);
      // Wait on the delivered transcripts, not just the socket close: the replacement
      // connection can close before its `transcription.done` reaches onTranscript.
      await vi.waitFor(
        () => {
          expect(requests).toHaveLength(2);
          expect(session.isConnected()).toBe(false);
          expect(texts(onTranscript)).toEqual(["earlier turn", "replacement final"]);
        },
        { timeout: 3_000 },
      );

      expect(texts(onPartial)).toEqual([...firstPartials, ...nextPartials]);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      session.close();
      vi.useRealTimers();
    }
  });

  it("tracks the in-progress transcript limit as aggregate UTF-8 bytes", async () => {
    const exactUtf8Limit = "🙂".repeat((256 * 1024) / 4);
    const splitSurrogatePrefix = "x".repeat(256 * 1024 - 4);
    const splitSurrogateTranscript = `${splitSurrogatePrefix}🙂`;
    const { onError, onTranscript } = await terminalSession([
      delta(exactUtf8Limit),
      segment("first segment"),
      delta(`${splitSurrogatePrefix}\ud83d`),
      delta("\ude42"),
      done(),
    ]);
    expect(texts(onTranscript)).toEqual(["first segment", splitSurrogateTranscript]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("fails once and ignores late terminal events after 10,000 runaway deltas", async () => {
    const { baseUrl, closed } = await createRealtimeServer([
      [
        ...Array.from({ length: 10_000 }, () => delta("x".repeat(32))),
        segment("late segment"),
        done("late done"),
      ],
    ]);
    const errorReceived = createDeferred<void>();
    const onError = vi.fn(() => errorReceived.resolve());
    const onTranscript = vi.fn();
    let lastPartialLength = 0;
    let partialCalls = 0;
    const session = createSession(baseUrl, {
      onError,
      onPartial: (partial) => {
        lastPartialLength = partial.length;
        partialCalls += 1;
      },
      onTranscript,
    });

    await session.connect();
    // Start the teardown deadline after overflow is reported, preserving the processing budget.
    await errorReceived.promise;
    await withTimeout(closed, 1_000, { message: "Mistral runaway-delta socket did not close" });
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "Mistral realtime transcription exceeded the 256 KiB in-progress transcript limit",
      }),
    );
    expect(session.isConnected()).toBe(false);

    expect(partialCalls).toBe(8_192);
    expect(lastPartialLength).toBe(256 * 1024);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("makes a ready-state provider error terminal and ignores late events", async () => {
    const { onError, onPartial, onTranscript } = await terminalSession([
      delta("draft"),
      { type: "error", error: { message: "provider failed" } },
      delta("x".repeat(256 * 1024 + 1)),
      segment("late segment"),
      done("late done"),
    ]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "provider failed" }),
    );
    expect(onPartial).toHaveBeenCalledExactlyOnceWith("draft");
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
