import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionWebSocketSessionOptions,
} from "openclaw/plugin-sdk/realtime-transcription-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { RawData } from "ws";
import { WebSocketServer } from "ws";
import { buildDeepgramRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const provider = buildDeepgramRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
});

let cleanup: (() => Promise<void>) | undefined;

async function createDeepgramRealtimeServer(params: {
  onRequest?: (url: URL, headers: Record<string, string | string[] | undefined>) => void;
  onConnection?: (ws: WebSocket) => void;
}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 * 1024 });
  wss.on("connection", (ws, request) => {
    params.onRequest?.(new URL(request.url ?? "/", "http://127.0.0.1"), request.headers);
    params.onConnection?.(ws);
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
  return { baseUrl: `http://127.0.0.1:${port}/deepgram/v1` };
}

function sendResult(
  ws: WebSocket,
  params: {
    text: string;
    isFinal?: boolean;
    speechFinal?: boolean;
    fromFinalize?: boolean;
  },
) {
  ws.send(
    JSON.stringify({
      type: "Results",
      channel: { alternatives: [{ transcript: params.text }] },
      is_final: params.isFinal ?? false,
      speech_final: params.speechFinal ?? false,
      from_finalize: params.fromFinalize ?? false,
    }),
  );
}

function parseClientMessage(data: RawData): Record<string, unknown> {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

/**
 * Host wrapper that reproduces the two ways an outbound control frame fails to
 * leave the process: `sendJson` returning false (stale, closed or superseded
 * socket, and backpressure) and the socket send throwing. Only frames sent from
 * the provider's message handler are affected, so the close path still behaves.
 */
function createControlFrameFailureHost(sendJson: (payload: unknown) => boolean) {
  return {
    createRealtimeTranscriptionWebSocketSession: <Event>(
      options: RealtimeTranscriptionWebSocketSessionOptions<Event>,
    ) =>
      createRealtimeTranscriptionWebSocketSession<Event>({
        ...options,
        onMessage: (event, transport) => options.onMessage?.(event, { ...transport, sendJson }),
      }),
  };
}

describe("buildDeepgramRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          deepgram: {
            apiKey: "dg-key",
            model: "nova-3",
            encoding: "g711_ulaw",
            sample_rate: "8000",
            interim_results: "true",
            endpointing: "500",
            language: "en-US",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "dg-key",
      baseUrl: undefined,
      model: "nova-3",
      language: "en-US",
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 500,
    });
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "Deepgram API key missing",
    );
  });

  it("rejects malformed endpoints", () => {
    expect(() =>
      provider.createSession({ providerConfig: { apiKey: "dg-key", baseUrl: "not a url" } }),
    ).toThrow(/^Invalid Deepgram baseUrl:/);
  });

  it("validates the environment override", () => {
    vi.stubEnv("DEEPGRAM_BASE_URL", "not a url");
    expect(() => provider.createSession({ providerConfig: { apiKey: "dg-key" } })).toThrow(
      "Invalid Deepgram baseUrl: value is not a valid URL",
    );
  });

  it("does not echo the configured URL in validation errors", () => {
    const rawMarker = "configured-value-marker";
    const nonHttp = `ftp://files.example.com/${rawMarker}`;
    try {
      provider.createSession({ providerConfig: { apiKey: "dg-key", baseUrl: nonHttp } });
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/^Invalid Deepgram baseUrl: unsupported scheme/);
      expect(message).not.toContain(rawMarker);
    }
  });

  it("connects through an explicit HTTP base URL over loopback WebSocket", async () => {
    const requests: Array<{
      url: URL;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    const server = await createDeepgramRealtimeServer({
      onRequest: (url, headers) => requests.push({ url, headers }),
    });
    const session = provider.createSession({
      providerConfig: {
        apiKey: "dummy",
        baseUrl: server.baseUrl,
      },
    });

    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/deepgram/v1/listen");
    expect(requests[0]?.url.searchParams.get("model")).toBe("nova-3");
    expect(requests[0]?.url.searchParams.get("endpointing")).toBe("800");
    expect(requests[0]?.url.searchParams.has("utterance_end_ms")).toBe(false);
    expect(requests[0]?.headers.authorization).toBe("Token dummy");
  });

  it("does not promote a rejected provisional tail on an empty speech-final result", async () => {
    const deliveryMarker = "rejected-tail frames delivered";
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "delete everything" });
        sendResult(ws, { text: "", isFinal: true, speechFinal: true });
        ws.send(JSON.stringify({ type: "SpeechStarted" }));
        // An error marker observes delivery without creating another speech turn.
        ws.send(JSON.stringify({ type: "Error", message: deliveryMarker }));
      },
    });
    const onPartial = vi.fn();
    const onSpeechStart = vi.fn();
    const framesDelivered = createDeferred<void>();
    const onError = vi.fn((error: Error) => {
      if (error.message === deliveryMarker) {
        framesDelivered.resolve();
      }
    });
    const onTranscript = vi.fn();
    const session = provider.createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 1000 },
      onPartial,
      onError,
      onSpeechStart,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => framesDelivered.promise);
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: deliveryMarker }),
      );
      expect(onSpeechStart).toHaveBeenCalledTimes(2);
    } finally {
      session.close();
    }

    expect(onPartial).toHaveBeenCalledWith("delete everything");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("preserves identical transcripts from consecutive utterances", async () => {
    const deliveryMarker = "consecutive-utterance frames delivered";
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "yes", isFinal: true, speechFinal: true });
        sendResult(ws, { text: "yes", isFinal: true, speechFinal: true });
        ws.send(JSON.stringify({ type: "Error", message: deliveryMarker }));
      },
    });
    const onTranscript = vi.fn();
    const framesDelivered = createDeferred<void>();
    const onError = vi.fn((error: Error) => {
      if (error.message === deliveryMarker) {
        framesDelivered.resolve();
      }
    });
    const session = provider.createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 1000 },
      onTranscript,
      onError,
    });

    try {
      await session.connect();
      await vi.waitFor(() => framesDelivered.promise);
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: deliveryMarker }),
      );
      expect(onTranscript).toHaveBeenCalledTimes(2);
    } finally {
      session.close();
    }

    expect(onTranscript.mock.calls).toEqual([["yes"], ["yes"]]);
  });

  it("flushes finalized text returned after a client finalize request", async () => {
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "good", isFinal: true });
        sendResult(ws, { text: "bye" });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            sendResult(ws, {
              text: "bye",
              isFinal: true,
              fromFinalize: true,
            });
          }
        });
      },
    });
    const transcriptReceived = createDeferred<string>();
    const onTranscript = vi.fn(transcriptReceived.resolve);
    const session = provider.createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 10_000 },
      onTranscript,
    });

    try {
      await session.connect();
      session.close();
      await vi.waitFor(() => transcriptReceived.promise);
      expect(onTranscript).toHaveBeenCalledWith("good bye");
      expect(onTranscript).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });

  it("flushes finalized text once when finalize produces no result", async () => {
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "good", isFinal: true });
        sendResult(ws, { text: "bye" });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
          }
        });
      },
    });
    const partialReceived = createDeferred<void>();
    const onPartial = vi.fn((text: string) => {
      if (text === "good bye") {
        partialReceived.resolve();
      }
    });
    const onTranscript = vi.fn();
    const session = provider.createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 10_000 },
      onPartial,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => partialReceived.promise);
      expect(onPartial).toHaveBeenCalledWith("good bye");
      vi.useFakeTimers();
      session.close();
      session.close();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(finalizeRequests).toBe(1);
      expect(onTranscript).toHaveBeenCalledTimes(1);
      expect(onTranscript).toHaveBeenCalledWith("good");
    } finally {
      if (vi.isFakeTimers()) {
        session.close();
      } else {
        // A failed observation can leave finalized text; close must own its fallback clock.
        vi.useFakeTimers();
        session.close();
        await vi.advanceTimersByTimeAsync(5_000).catch(() => undefined);
      }
    }
  });

  it("does not commit a turn on an utterance-end gap before speech-final", async () => {
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "still", isFinal: true });
        ws.send(JSON.stringify({ type: "UtteranceEnd" }));
        sendResult(ws, { text: "speaking", isFinal: true, speechFinal: true });
      },
    });
    const onPartial = vi.fn();
    const transcriptReceived = createDeferred<string>();
    const onTranscript = vi.fn(transcriptReceived.resolve);
    const session = provider.createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 25 },
      onPartial,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => transcriptReceived.promise);
      expect(onTranscript).toHaveBeenCalledWith("still speaking");
    } finally {
      session.close();
    }

    expect(onPartial).toHaveBeenCalledWith("still");
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("does not infer silence from a gap between provisional results", async () => {
    vi.useFakeTimers();
    let socket: WebSocket | undefined;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        socket = ws;
        sendResult(ws, { text: "still speaking" });
      },
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = provider.createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 25 },
      onPartial,
      onTranscript,
    });

    await session.connect();
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("still speaking"));
    await vi.advanceTimersByTimeAsync(350);
    expect(onTranscript).not.toHaveBeenCalled();

    sendResult(socket!, { text: "continuous speech", isFinal: true, speechFinal: true });
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("continuous speech"));
    session.close();
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("asks the provider to finalize a turn whose transcript stopped growing", async () => {
    vi.useFakeTimers();
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "stalled question", isFinal: true });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
            // Deepgram answers the request. The provider still owns the turn
            // boundary; the host only asked it to decide now.
            sendResult(ws, { text: "", isFinal: true, fromFinalize: true });
          }
        });
      },
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "test-key",
        baseUrl: server.baseUrl,
        endpointingMs: 25,
        idleFlushMs: 50,
      },
      onPartial,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("stalled question"));
      // Endpointing never produced speech_final, so nothing has committed.
      expect(finalizeRequests).toBe(0);
      expect(onTranscript).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(finalizeRequests).toBe(1));
      await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("stalled question"));
    } finally {
      session.close();
    }
  });

  it("still finalizes when the provider repeats one interim transcript forever", async () => {
    vi.useFakeTimers();
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        // Deepgram repeats the same interim transcript with no terminal signal,
        // each repeat landing inside the idle window. The transcript stopped
        // growing, so these repeats must not postpone the backstop.
        const repeat = () => {
          if (ws.readyState !== ws.OPEN) {
            return;
          }
          sendResult(ws, { text: "stalled question" });
          setTimeout(repeat, 25);
        };
        repeat();
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
          }
        });
      },
    });
    const onTranscript = vi.fn();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "***",
        baseUrl: server.baseUrl,
        endpointingMs: 25,
        idleFlushMs: 50,
      },
      onPartial: vi.fn(),
      onTranscript,
    });

    try {
      await session.connect();
      // The repeats never stop, so a timer rearmed by every nonempty event
      // would never fire and this would time out.
      await vi.waitFor(() => expect(finalizeRequests).toBeGreaterThanOrEqual(1));
      // The provider never answered, so the turn is still its to end.
      expect(onTranscript).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it("lets provider endpointing win before the idle finalize request", async () => {
    vi.useFakeTimers();
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        // Healthy audio: endpointing ends the turn on its own.
        sendResult(ws, { text: "complete question" });
        sendResult(ws, { text: "complete question", isFinal: true, speechFinal: true });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
          }
        });
      },
    });
    const onTranscript = vi.fn();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "test-key",
        baseUrl: server.baseUrl,
        endpointingMs: 25,
        idleFlushMs: 50,
      },
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("complete question"));

      // speech_final already committed the turn, so the backstop must stay quiet
      // rather than asking for a second, redundant finalize.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finalizeRequests).toBe(0);
      expect(onTranscript).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });

  it("keeps a turn pending when the provider never answers the idle finalize", async () => {
    vi.useFakeTimers();
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "stalled question", isFinal: true });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
            // Deepgram answers with nothing at all: no Results event follows.
          }
        });
      },
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "***",
        baseUrl: server.baseUrl,
        endpointingMs: 25,
        idleFlushMs: 50,
      },
      onPartial,
      onTranscript,
      onError,
    });

    try {
      await session.connect();
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("stalled question"));
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(finalizeRequests).toBe(1));

      // An is_final segment is confirmed text, not a completed utterance. With
      // the call still open and no speech_final or from_finalize in sight, the
      // host must not invent the provider's turn boundary: the turn stays
      // pending and the unanswered request surfaces as a recoverable failure.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onTranscript).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining("idle finalize request went unanswered"),
          }),
        ),
      );
    } finally {
      session.close();
    }
  });

  it("does not watch for an answer when the idle finalize request was refused", async () => {
    vi.useFakeTimers();
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "stalled question", isFinal: true });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
          }
        });
      },
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const onError = vi.fn();
    // sendJson reports false before it touches the socket for a stale or closed
    // connection, and again for backpressure. The frame never leaves.
    const host = createControlFrameFailureHost(() => false);
    const session = buildDeepgramRealtimeTranscriptionProvider(host).createSession({
      providerConfig: {
        apiKey: "***",
        baseUrl: server.baseUrl,
        endpointingMs: 25,
        idleFlushMs: 50,
      },
      onPartial,
      onTranscript,
      onError,
    });

    try {
      await session.connect();
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("stalled question"));
      await vi.advanceTimersByTimeAsync(10_000);

      // A request that was never sent cannot draw a provider terminal result,
      // so nothing is waiting on one: no watchdog, no reported timeout, and the
      // turn is still pending for the next Results event to ask about.
      expect(finalizeRequests).toBe(0);
      expect(onTranscript).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it("does not watch for an answer when the idle finalize request throws", async () => {
    vi.useFakeTimers();
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "stalled question", isFinal: true });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
          }
        });
      },
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const host = createControlFrameFailureHost((): boolean => {
      throw new Error("socket send failed");
    });
    const session = buildDeepgramRealtimeTranscriptionProvider(host).createSession({
      providerConfig: {
        apiKey: "***",
        baseUrl: server.baseUrl,
        endpointingMs: 25,
        idleFlushMs: 50,
      },
      onPartial,
      onTranscript,
      onError,
    });

    try {
      await session.connect();
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("stalled question"));
      await vi.advanceTimersByTimeAsync(10_000);

      // The send failure is reported once. It must not also arm the watchdog,
      // which would report a missing answer to a request nobody made.
      expect(finalizeRequests).toBe(0);
      expect(onTranscript).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "socket send failed" }),
      );
    } finally {
      session.close();
    }
  });

  it("keeps a turn pending when an idle finalize cannot complete it", async () => {
    vi.useFakeTimers();
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "what is the", isFinal: true });
        sendResult(ws, { text: "weather like" });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
          }
        });
      },
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "***",
        baseUrl: server.baseUrl,
        endpointingMs: 25,
        idleFlushMs: 50,
      },
      onPartial,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("what is the weather like"));
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(finalizeRequests).toBe(1));

      // A provisional tail means the utterance has not ended. Recovery must not
      // hand up the confirmed prefix as though it were the whole question.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onTranscript).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it("leaves the idle finalize request disabled unless idleFlushMs is configured", async () => {
    vi.useFakeTimers();
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "stalled question", isFinal: true });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
          }
        });
      },
    });
    const onPartial = vi.fn();
    const session = provider.createSession({
      // idleFlushMs deliberately omitted: existing installs must not inherit it.
      providerConfig: { apiKey: "***", baseUrl: server.baseUrl, endpointingMs: 25 },
      onPartial,
      onTranscript: vi.fn(),
    });

    try {
      await session.connect();
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("stalled question"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(finalizeRequests).toBe(0);
    } finally {
      session.close();
    }
  });

  it("does not arm the idle finalize request when idleFlushMs is zero", async () => {
    vi.useFakeTimers();
    let finalizeRequests = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "stalled question", isFinal: true });
        ws.on("message", (data) => {
          if (parseClientMessage(data).type === "Finalize") {
            finalizeRequests += 1;
          }
        });
      },
    });
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "test-key",
        baseUrl: server.baseUrl,
        endpointingMs: 25,
        idleFlushMs: 0,
      },
      onPartial,
      onTranscript,
    });

    try {
      await session.connect();
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("stalled question"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finalizeRequests).toBe(0);
      expect(onTranscript).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it.each([
    { name: "discards provisional speech", isFinal: false, expected: [["new"]] },
    {
      name: "preserves finalized speech as a separate turn",
      isFinal: true,
      expected: [["old"], ["new"]],
    },
  ])("$name when the provider reconnects", async ({ isFinal, expected }) => {
    vi.useFakeTimers();
    let connectionCount = 0;
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        connectionCount += 1;
        if (connectionCount === 1) {
          sendResult(ws, { text: "old", isFinal });
          ws.close();
          return;
        }
        sendResult(ws, { text: "new", isFinal: true, speechFinal: true });
      },
    });
    const onTranscript = vi.fn();
    const session = provider.createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 10_000 },
      onTranscript,
    });

    await session.connect();
    // Observe the real socket close before advancing the provider's retry delay.
    await vi.waitFor(() => expect(session.isConnected()).toBe(false));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledTimes(expected.length), {
      timeout: 3000,
    });
    session.close();

    expect(onTranscript.mock.calls).toEqual(expected);
  });

  it("terminates instead of retaining an oversized utterance", async () => {
    const server = await createDeepgramRealtimeServer({
      onConnection: (ws) => {
        sendResult(ws, { text: "x".repeat(256 * 1024), isFinal: true });
        sendResult(ws, { text: "y" });
      },
    });
    const errorReceived = createDeferred<Error>();
    const onError = vi.fn(errorReceived.resolve);
    const session = provider.createSession({
      providerConfig: { apiKey: "dummy", baseUrl: server.baseUrl, endpointingMs: 1000 },
      onError,
    });

    try {
      await session.connect();
      await vi.waitFor(() => errorReceived.promise);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("retained transcript exceeded"),
        }),
      );
      expect(session.isConnected()).toBe(false);
    } finally {
      session.close();
    }
  });
});
