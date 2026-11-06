import { createServer } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const provider = buildMistralRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
});
let cleanup: (() => Promise<void>) | undefined;
const delta = (text: string) => ({ type: "transcription.text.delta", text });
const done = (text?: string) => ({ type: "transcription.done", text });
const failure = (message: string) => ({ type: "error", error: { message } });
const oversized = delta("x".repeat(256 * 1024 + 1));
const limitMessage =
  "Mistral realtime transcription exceeded the 256 KiB in-progress transcript limit";
const segment = (text: string, start = 0, speaker_id?: string) => ({
  type: "transcription.segment",
  text,
  start,
  end: start + 1,
  speaker_id,
});
const pending = (text: string, aggregate: string) => [
  segment("hello"),
  delta(text),
  done(aggregate),
];
const texts = (callback: (text: string) => void) =>
  vi.mocked(callback).mock.calls.map(([text]) => text);

async function createRealtimeServer(
  eventsByConnection: readonly (readonly Record<string, unknown>[])[] = [[]],
  config: Parameters<typeof provider.createSession>[0]["providerConfig"] = {},
  onPartial: (text: string) => void = vi.fn(),
) {
  const requests: URL[] = [];
  const sockets: WebSocket[] = [];
  const closed = createDeferred<void>();
  const errorReceived = createDeferred<void>();
  const onError = vi.fn(() => errorReceived.resolve());
  const onTranscript = vi.fn();
  const server = createServer();
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  wss.on("connection", (ws, request) => {
    const connectionIndex = sockets.push(ws) - 1;
    requests.push(new URL(request.url ?? "/", "http://127.0.0.1"));
    ws.on("close", () => closed.resolve());
    ws.on("message", (data) => {
      const message = JSON.parse(rawDataToString(data, "utf8")) as { type?: unknown };
      if (message.type === "session.update") {
        for (const event of eventsByConnection[connectionIndex] ?? []) {
          ws.send(JSON.stringify(event));
        }
      }
    });
    ws.send(JSON.stringify({ type: "session.created" }));
  });
  const port = await listenOnLoopback(server);
  const session = provider.createSession({
    providerConfig: { apiKey: "fixture-value", ...config, baseUrl: `http://127.0.0.1:${port}/v1` },
    onPartial,
    onTranscript,
    onError,
  });
  cleanup = async () => {
    session.close();
    wss.clients.forEach((ws) => ws.terminate());
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await server[Symbol.asyncDispose]();
  };
  await session.connect();
  return {
    requests,
    sockets,
    session,
    onPartial,
    onTranscript,
    onError,
    errorReceived: errorReceived.promise,
    waitClosed: async () => {
      await withTimeout(closed.promise, 1_000, {
        message: "Mistral terminal socket did not close",
      });
      expect(session.isConnected()).toBe(false);
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await cleanup?.();
  cleanup = undefined;
  vi.unstubAllEnvs();
});

it("normalizes nested provider config and connects with its URL parameters", async () => {
  const mistral = {
    apiKey: "  sk-\r\nmistral│  ",
    model: "fixture-model",
    encoding: "g711_ulaw",
    sample_rate: "8000",
    target_streaming_delay_ms: "240",
  };
  const resolved = provider.resolveConfig?.({
    cfg: {} as OpenClawConfig,
    rawConfig: { providers: { mistral } },
  });

  expect(resolved).toEqual({
    apiKey: "sk-mistral",
    baseUrl: undefined,
    model: "fixture-model",
    encoding: "pcm_mulaw",
    sampleRate: 8000,
    targetStreamingDelayMs: 240,
  });
  const { requests } = await createRealtimeServer([], resolved);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.pathname).toBe("/v1/audio/transcriptions/realtime");
  expect(requests[0]?.searchParams.get("model")).toBe("fixture-model");
  expect(requests[0]?.searchParams.get("target_streaming_delay_ms")).toBe("240");
});

it("requires an API key when creating sessions", () => {
  vi.stubEnv("MISTRAL_API_KEY", "");
  expect(() => provider.createSession({ providerConfig: {} })).toThrow("Mistral API key missing");
});

it.each<[string, Record<string, unknown>[], string[], string[]]>([
  ["terminal-only text", [done("final transcript")], [], ["final transcript"]],
  ["corrected final", [delta("a"), delta("b"), done("c")], ["a", "ab"], ["c"]],
  ["timed repeats", [segment("a", 0, "x"), segment("a", 1, "y"), done("b")], [], ["a", "a"]],
  [
    "flushes post-segment deltas without aggregate replay",
    [delta("hello"), segment("hello"), delta(" new"), delta(" speech"), done("hello new speech")],
    ["hello", " new", " new speech"],
    ["hello", " new speech"],
  ],
  ["pending whitespace", pending("  \t", "hello  "), ["  \t"], ["hello"]],
  ["pending punctuation", pending(".", "hello."), ["."], ["hello"]],
  ["pending letters", pending(", 你好", "hello, 你好"), [", 你好"], ["hello", ", 你好"]],
  ["pending numbers", pending(" 42", "hello 42"), [" 42"], ["hello", " 42"]],
])("%s", async (_name, events, partials, transcripts) => {
  const { onPartial, onTranscript, waitClosed } = await createRealtimeServer([events]);
  await waitClosed();
  expect(texts(onTranscript)).toEqual(transcripts);
  expect(vi.mocked(onPartial).mock.calls).toEqual(partials.map((text) => [text]));
});

it.each<[string, string[], string[]]>([
  ["terminal-only speech", [], []],
  ["isolates interrupted partials", ["old fragment "], ["new fragment"]],
])("%s after a real provider reconnect", async (_name, firstPartials, nextPartials) => {
  const { session, onPartial, onTranscript, onError, requests, sockets } =
    await createRealtimeServer([
      [segment("earlier turn"), ...firstPartials.map(delta)],
      [...nextPartials.map(delta), done("replacement final")],
    ]);

  await vi.waitFor(() => {
    expect(texts(onTranscript)).toEqual(["earlier turn"]);
    expect(texts(onPartial)).toEqual(firstPartials);
  });
  vi.useFakeTimers();
  sockets.forEach((socket) => socket.terminate());
  // The real close must arm the retry before its backoff clock advances.
  await vi.waitFor(() => expect(session.isConnected()).toBe(false));
  await vi.advanceTimersByTimeAsync(1_000);
  // The replacement socket can close before its final transcript is delivered.
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
});

it("tracks the in-progress transcript limit as aggregate UTF-8 bytes", async () => {
  const exactUtf8Limit = "🙂".repeat((256 * 1024) / 4);
  const splitSurrogatePrefix = "x".repeat(256 * 1024 - 4);
  const splitSurrogateTranscript = `${splitSurrogatePrefix}🙂`;
  const { onError, onTranscript, waitClosed } = await createRealtimeServer([
    [
      delta(exactUtf8Limit),
      segment("first segment"),
      delta(`${splitSurrogatePrefix}\ud83d`),
      delta("\ude42"),
      done(),
    ],
  ]);
  await waitClosed();
  expect(texts(onTranscript)).toEqual(["first segment", splitSurrogateTranscript]);
  expect(onError).not.toHaveBeenCalled();
});

it.each<[string, Record<string, unknown>[], number, string | number]>([
  [limitMessage, Array.from({ length: 10_000 }, () => delta("x".repeat(32))), 8_192, 256 * 1024],
  ["provider failed", [delta("draft"), failure("provider failed"), oversized], 1, "draft"],
])("fails once and ignores late events: %s", async (message, events, count, last) => {
  let lastPartial = "";
  let partialCalls = 0;
  const { waitClosed, errorReceived, onError, onTranscript } = await createRealtimeServer(
    [[...events, segment("late segment"), done("late done")]],
    {},
    (partial) => {
      lastPartial = partial;
      partialCalls += 1;
    },
  );

  // Start the teardown deadline after overflow is reported, preserving the processing budget.
  await errorReceived;
  await waitClosed();
  expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));

  expect(partialCalls).toBe(count);
  expect(typeof last === "number" ? lastPartial.length : lastPartial).toBe(last);
  expect(onTranscript).not.toHaveBeenCalled();
});
