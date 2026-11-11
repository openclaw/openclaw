import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type {
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import * as realtimeVoiceSdk from "openclaw/plugin-sdk/realtime-voice";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { MediaStreamHandler, type MediaStreamConfig } from "./media-stream.js";
import {
  createHandler,
  createStubSession,
  createStubSttProvider,
  sendStart,
  startWsServer,
  waitForAbort,
  withConnection,
} from "./media-stream.test-support.js";
import { connectWs, waitForClose, withTimeout } from "./websocket-test-support.js";

function seedStreamSession(
  handler: MediaStreamHandler,
  ws: WebSocket,
  streamSid: string,
  callId: string,
) {
  (handler as unknown as { sessions: MediaStreamHandler["sessions"] }).sessions.set(streamSid, {
    callId,
    streamSid,
    ws,
    sttSession: createStubSession(),
    talk: realtimeVoiceSdk.createTalkSessionController({
      sessionId: `voice-call:${callId}:${streamSid}`,
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
    }),
  });
}

async function withServer(handler: MediaStreamHandler, run: (url: string) => Promise<void>) {
  const server = await startWsServer(handler);
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

async function closeWs(...sockets: WebSocket[]) {
  await Promise.all(
    sockets.map((ws) => {
      const closed = waitForClose(ws);
      ws.close();
      return closed;
    }),
  );
}

function sendMedia(ws: WebSocket, payload: string, streamSid?: string) {
  ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
}

function createAcceptedHandler(
  session: RealtimeTranscriptionSession,
  options: Partial<MediaStreamConfig> = {},
) {
  return createHandler({
    transcriptionProvider: createStubSttProvider(() => session),
    shouldAcceptStream: () => true,
    ...options,
  });
}

function captureConsole(method: "log" | "error") {
  const spy = vi.spyOn(console, method).mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  return spy;
}

function observeTalk(callSid: string, streamSid: string) {
  const spy = vi.spyOn(realtimeVoiceSdk, "recordTalkObservabilityEvent");
  onTestFinished(() => spy.mockRestore());
  return () =>
    spy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.sessionId === `voice-call:${callSid}:${streamSid}`);
}

describe("MediaStreamHandler security hardening", () => {
  it("wraps malformed Twilio media stream JSON with an owned parser error", async () => {
    const errorSpy = captureConsole("error");
    const handler = createHandler();
    await withConnection(handler, async (ws) => {
      ws.send("{not json");

      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          "[MediaStream] Error processing message:",
          expect.objectContaining({
            message: "Twilio media stream message was malformed JSON",
          }),
        );
      });
      const error = errorSpy.mock.calls.find(
        ([message]) => message === "[MediaStream] Error processing message:",
      )?.[1];
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SyntaxError);
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);

      await closeWs(ws);
    });
  });

  it("admits string start fields before asking the stream acceptance policy", async () => {
    const shouldAcceptStream = vi.fn(() => false);
    const handler = createHandler({ shouldAcceptStream });
    await withConnection(handler, async (ws) => {
      try {
        for (const frame of [
          { event: "start", streamSid: 42, start: { callSid: "CA-admission" } },
          { event: "start", streamSid: "MZ-admission", start: { callSid: 42 } },
          {
            event: "start",
            streamSid: "MZ-admission",
            start: { callSid: "CA-admission", customParameters: { token: 42 } },
          },
        ]) {
          ws.send(JSON.stringify(frame));
        }
        sendStart(ws, "MZ-admission", "CA-admission", { token: "synthetic-stream-token" });
        await waitForClose(ws);
        expect(shouldAcceptStream).toHaveBeenCalledExactlyOnceWith({
          callId: "CA-admission",
          streamSid: "MZ-admission",
          token: "synthetic-stream-token",
        });
      } finally {
        ws.terminate();
      }
    });
  });

  it("rejects start frames when no stream acceptance validator is configured", async () => {
    const createSession = vi.fn(() => createStubSession());
    const handler = createHandler({
      transcriptionProvider: createStubSttProvider(createSession),
    });
    await withConnection(handler, async (ws) => {
      sendStart(ws, "MZ-unvalidated", "CA-unvalidated");

      const closed = await waitForClose(ws);

      expect(closed).toEqual({ code: 1008, reason: "Unauthorized stream" });
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  it("emits common Talk events for telephony STT/TTS sessions", async () => {
    let callbacks: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sentAudio: Buffer[] = [];
    const session: RealtimeTranscriptionSession = {
      ...createStubSession(),
      sendAudio: (audio) => {
        sentAudio.push(Buffer.from(audio));
      },
    };
    const talkEvents = observeTalk("CA-talk", "MZ-talk");
    const handler = createHandler({
      transcriptionProvider: createStubSttProvider((request) => {
        callbacks = request;
        return session;
      }),
      shouldAcceptStream: () => true,
    });
    await withConnection(handler, async (ws) => {
      sendStart(ws, "MZ-talk", "CA-talk");
      await vi.waitFor(() =>
        expect(talkEvents().map((event) => event.type)).toContain("session.ready"),
      );

      sendMedia(ws, Buffer.from("hello").toString("base64"), "MZ-talk");
      await vi.waitFor(() => expect(Buffer.concat(sentAudio).toString()).toBe("hello"));

      callbacks?.onSpeechStart?.();
      callbacks?.onPartial?.("hel");
      callbacks?.onTranscript?.("hello there");

      const outboundAudio = nextWsMessage(ws);
      await handler.queueTts("MZ-talk", async () => {
        handler.sendAudio("MZ-talk", Buffer.alloc(160, 0xff));
      });
      await withTimeout(outboundAudio);

      const outboundMark = nextWsMessage(ws);
      const activePlayback = handler.queueTts("MZ-talk", async (signal) => {
        await Promise.all([
          handler.sendMarkAndWait("MZ-talk", "tts-cleared", 100, signal),
          waitForAbort(signal),
        ]);
      });
      expect(await withTimeout(outboundMark)).toMatchObject({
        event: "mark",
        mark: { name: "tts-cleared" },
      });
      handler.clearTtsQueue("MZ-talk", "barge-in");
      await activePlayback;
      echoMark(ws, "MZ-talk", "tts-cleared");

      await closeWs(ws);
      await vi.waitFor(() =>
        expect(talkEvents().map((event) => event.type)).toContain("session.closed"),
      );

      expect(talkEvents().map((event) => event.type)).toEqual([
        "session.started",
        "session.ready",
        "turn.started",
        "input.audio.delta",
        "transcript.delta",
        "input.audio.committed",
        "transcript.done",
        "output.audio.started",
        "output.audio.delta",
        "output.audio.done",
        "turn.ended",
        "turn.started",
        "output.audio.started",
        "turn.cancelled",
        "session.closed",
      ]);
      expect(talkEvents()[0]).toMatchObject({
        sessionId: "voice-call:CA-talk:MZ-talk",
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        seq: 1,
      });
      expect(talkEvents().find((event) => event.type === "transcript.done")).toMatchObject({
        final: true,
        turnId: "MZ-talk:turn-1",
        payload: { text: "hello there", role: "user" },
      });
      expect(talkEvents().find((event) => event.type === "turn.cancelled")).toMatchObject({
        final: true,
        turnId: "MZ-talk:turn-2",
        payload: { reason: "barge-in" },
      });
    });
  });

  it.each([
    ["before", 2 * 1024 * 1024, 0],
    ["after", 0, 1],
  ] as const)(
    "closes streams when buffered bytes exceed the cap %s enqueueing",
    (phase, bufferedAmount, sent) => {
      const handler = createHandler();
      const socket = {
        readyState: WebSocket.OPEN,
        bufferedAmount,
        send: vi.fn(() => {
          socket.bufferedAmount = 2 * 1024 * 1024;
        }),
        close: vi.fn(),
      };
      seedStreamSession(
        handler,
        socket as unknown as WebSocket,
        "MZ-backpressure",
        "CA-backpressure",
      );
      const result =
        phase === "before"
          ? handler.sendAudio("MZ-backpressure", Buffer.alloc(160, 0xff))
          : handler.sendMark("MZ-backpressure", "mark-1");
      expect(result).toBe(false);
      expect(socket.send).toHaveBeenCalledTimes(sent);
      expect(socket.close).toHaveBeenCalledWith(1013, "Backpressure: send buffer exceeded");
    },
  );

  it.each([
    {
      name: "sanitizes control characters",
      input: "forged\nline\r\tentry",
      expected: "forged line entry",
      forbidden: ["\n", "\r", "\t"],
    },
    {
      name: "truncates without splitting UTF-16",
      input: `${"a".repeat(119)}\uD83D\uDE80`,
      expected: `${"a".repeat(119)}...`,
      forbidden: ["\uD83D", "\uDE80"],
    },
  ])("$name in websocket close logs", async ({ input, expected, forbidden }) => {
    const logSpy = captureConsole("log");
    await withConnection(createHandler(), async (ws) => {
      ws.close(1000, input);
      await waitForClose(ws);
      await vi.waitFor(() =>
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`reason: ${expected}`)),
      );
      const line = logSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes("WebSocket closed"));
      for (const text of forbidden) {
        expect(line).not.toContain(text);
      }
    });
  });

  it("closes idle pre-start connections after timeout", async () => {
    const shouldAcceptStream = vi.fn(() => true);
    const handler = createHandler({ preStartTimeoutMs: 40, shouldAcceptStream });
    await withConnection(handler, async (ws) => {
      const closed = await waitForClose(ws);

      expect(closed).toEqual({ code: 1008, reason: "Start timeout" });
      expect(shouldAcceptStream).not.toHaveBeenCalled();
    });
  });

  it("clamps oversized pre-start connection timeouts", () => {
    vi.useFakeTimers();
    try {
      const handler = createHandler({ preStartTimeoutMs: Number.MAX_SAFE_INTEGER });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const ws = { close: vi.fn() } as unknown as WebSocket;

      const registered = (
        handler as unknown as {
          registerPendingConnection(ws: WebSocket, ip: string): boolean;
        }
      ).registerPendingConnection(ws, "203.0.113.10");

      expect(registered).toBe(true);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces pending connection limits", async () => {
    const handler = createHandler({
      preStartTimeoutMs: 5_000,
      maxPendingConnections: 1,
      maxPendingConnectionsPerIp: 1,
    });
    await withServer(handler, async (url) => {
      const first = await connectWs(url);
      const second = await connectWs(url);
      const secondClosed = await waitForClose(second);

      expect(secondClosed.code).toBe(1013);
      expect(secondClosed.reason).toContain("Too many pending");
      expect(first.readyState).toBe(WebSocket.OPEN);

      await closeWs(first);
    });
  });

  it("uses resolved client IPs for per-IP pending limits", async () => {
    const handler = createHandler({
      preStartTimeoutMs: 5_000,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 1,
      resolveClientIp: (request) => String(request.headers["x-forwarded-for"] ?? ""),
    });
    await withServer(handler, async (url) => {
      const connectFrom = async (ip: string) => {
        const ws = new WebSocket(url, { headers: { "x-forwarded-for": ip } });
        await withTimeout(
          new Promise((resolve) => {
            ws.once("open", resolve);
          }),
        );
        return ws;
      };
      const first = await connectFrom("198.51.100.10");
      const second = await connectFrom("203.0.113.20");

      expect(first.readyState).toBe(WebSocket.OPEN);
      expect(second.readyState).toBe(WebSocket.OPEN);

      await closeWs(first, second);
    });
  });

  it("counts in-flight upgrades against the max connection cap", () => {
    const handler = createHandler({
      maxConnections: 2,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });

    const fakeWss = {
      clients: new Set([{}]),
      handleUpgrade:
        vi.fn<
          (
            request: IncomingMessage,
            socket: unknown,
            head: Buffer,
            callback: (ws: WebSocket) => void,
          ) => void
        >(),
      emit: vi.fn(),
      on: vi.fn(),
    };
    (
      handler as unknown as {
        wss: typeof fakeWss;
      }
    ).wss = fakeWss;

    const makeSocket = () => ({
      once: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    });
    const firstSocket = makeSocket();
    handler.handleUpgrade(
      { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      firstSocket as never,
      Buffer.alloc(0),
    );

    const secondSocket = makeSocket();
    handler.handleUpgrade(
      { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      secondSocket as never,
      Buffer.alloc(0),
    );

    expect(fakeWss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(secondSocket.write).toHaveBeenCalledOnce();
    expect(secondSocket.destroy).toHaveBeenCalledOnce();

    const completeUpgrade = fakeWss.handleUpgrade.mock.calls[0]?.[3];
    if (!completeUpgrade) {
      throw new Error("Expected upgrade callback to be registered");
    }
    completeUpgrade({} as WebSocket);
    expect(fakeWss.emit).toHaveBeenCalledOnce();
    expect(fakeWss.emit).toHaveBeenCalledWith(
      "connection",
      expect.anything(),
      expect.objectContaining({ socket: expect.objectContaining({ remoteAddress: "127.0.0.1" }) }),
    );
  });

  it("releases in-flight reservations when ws rejects a malformed upgrade before the callback", async () => {
    const handler = createHandler({
      preStartTimeoutMs: 5_000,
      maxConnections: 1,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    await withServer(handler, async (url) => {
      const serverUrl = new URL(url);
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(
            { host: serverUrl.hostname, port: Number(serverUrl.port) },
            () => {
              socket.write(
                [
                  "GET /voice/stream HTTP/1.1",
                  `Host: ${serverUrl.host}`,
                  "Upgrade: websocket",
                  "Connection: Upgrade",
                  "Sec-WebSocket-Version: 13",
                  "",
                  "",
                ].join("\r\n"),
              );
            },
          );
          socket.once("error", reject);
          socket.once("data", () => {
            socket.end();
          });
          socket.once("close", () => resolve());
        }),
      );

      const ws = await connectWs(url);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      await closeWs(ws);
    });
  });

  it("clears pending state after valid start", async () => {
    const shouldAcceptStream = vi.fn<NonNullable<MediaStreamConfig["shouldAcceptStream"]>>(
      () => true,
    );
    const handler = createHandler({
      maxPendingConnections: 1,
      maxPendingConnectionsPerIp: 10,
      preStartTimeoutMs: 5_000,
      shouldAcceptStream,
    });
    await withConnection(handler, async (ws, url) => {
      sendStart(ws, "MZ123", "CA123", { token: "token-123" });

      await vi.waitFor(() =>
        expect(shouldAcceptStream).toHaveBeenCalledExactlyOnceWith({
          callId: "CA123",
          streamSid: "MZ123",
          token: "token-123",
        }),
      );
      expect(ws.readyState).toBe(WebSocket.OPEN);

      const second = await connectWs(url);
      expect(second.readyState).toBe(WebSocket.OPEN);

      await closeWs(second);
      await closeWs(ws);
    });
  });

  it("forwards early Twilio media into the STT session before readiness", async () => {
    const sttReady = createDeferred<void>();
    const sttConnectStarted = createDeferred<void>();
    const transcriptionReady = createDeferred<void>();
    const audioReceived = createDeferred<void>();
    const receivedAudio: Buffer[] = [];
    const onConnect = vi.fn();
    const onTranscriptionReady = vi.fn(() => transcriptionReady.resolve());

    const session: RealtimeTranscriptionSession = {
      ...createStubSession(),
      connect: async () => {
        expect(onConnect).toHaveBeenCalledOnce();
        sttConnectStarted.resolve();
        await sttReady.promise;
      },
      sendAudio: (audio) => {
        receivedAudio.push(Buffer.from(audio));
        audioReceived.resolve();
      },
      isConnected: () => false,
    };

    const handler = createAcceptedHandler(session, {
      onConnect,
      onTranscriptionReady,
    });
    await withConnection(handler, async (ws) => {
      try {
        sendStart(ws, "MZ-early-media", "CA-early-media");

        await withTimeout(sttConnectStarted.promise);
        sendMedia(ws, Buffer.from("early").toString("base64"), "MZ-early-media");
        await withTimeout(audioReceived.promise);

        expect(Buffer.concat(receivedAudio).toString()).toBe("early");
        expect(onConnect).toHaveBeenCalledOnce();
        expect(onTranscriptionReady).not.toHaveBeenCalled();

        sttReady.resolve();
        await withTimeout(transcriptionReady.promise);
        expect(onConnect).toHaveBeenCalledOnce();
        expect(onTranscriptionReady).toHaveBeenCalledOnce();
      } finally {
        sttReady.resolve();
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        if (ws.readyState !== WebSocket.CLOSED) {
          await waitForClose(ws).catch(() => {});
        }
      }
    });
  });

  it("closes the media stream and disconnects once when STT readiness fails", async () => {
    const sttConnectStarted = createDeferred<void>();
    const onDisconnectReady = createDeferred<void>();
    const onConnect = vi.fn();
    const onTranscriptionReady = vi.fn();
    const onDisconnect = vi.fn(() => onDisconnectReady.resolve());

    const session: RealtimeTranscriptionSession = {
      ...createStubSession(),
      connect: async () => {
        sttConnectStarted.resolve();
        throw new Error("provider unavailable");
      },
      close: vi.fn(),
      isConnected: () => false,
    };

    const handler = createAcceptedHandler(session, {
      onConnect,
      onTranscriptionReady,
      onDisconnect,
    });
    await withConnection(handler, async (ws) => {
      sendStart(ws, "MZ-stt-fail", "CA-stt-fail");

      await withTimeout(sttConnectStarted.promise);
      const closed = await waitForClose(ws);
      await withTimeout(onDisconnectReady.promise);

      expect(closed).toEqual({ code: 1011, reason: "STT connection failed" });
      expect(onConnect).toHaveBeenCalledExactlyOnceWith("CA-stt-fail", "MZ-stt-fail");
      expect(onTranscriptionReady).not.toHaveBeenCalled();
      expect(onDisconnect).toHaveBeenCalledExactlyOnceWith("CA-stt-fail", "MZ-stt-fail");
      expect(session["close"]).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects oversized pre-start frames at the websocket maxPayload guard before validation runs", async () => {
    const shouldAcceptStream = vi.fn(() => true);
    const handler = createHandler({ preStartTimeoutMs: 1_000, shouldAcceptStream });
    await withConnection(handler, async (ws) => {
      sendStart(ws, "MZ-oversized", "CA-oversized", {
        token: "token-oversized",
        padding: "A".repeat(256 * 1024),
      });

      const closed = await waitForClose(ws);

      expect(closed.code).toBe(1009);
      expect(shouldAcceptStream).not.toHaveBeenCalled();
    });
  });
  it("drops malformed media frames while keeping the stream usable", async () => {
    const errors = captureConsole("error");
    const sentAudio: Buffer[] = [];
    const session: RealtimeTranscriptionSession = {
      ...createStubSession(),
      sendAudio: (audio) => sentAudio.push(Buffer.from(audio)),
    };
    const handler = createAcceptedHandler(session);
    await withConnection(handler, async (ws) => {
      try {
        sendStart(ws, "MZ-base64", "CA-base64");
        for (const payload of [42, true, {}, [], null]) {
          ws.send(JSON.stringify({ event: "media", media: { payload } }));
        }
        ws.send(JSON.stringify({ event: "mark", mark: { name: 42 } }));
        for (const payload of ["!!!not-valid-base64!!!", "   \t\n  "]) {
          sendMedia(ws, payload);
        }
        sendMedia(ws, "-_8");
        sendMedia(ws, Buffer.from("valid").toString("base64"));

        await vi.waitFor(() =>
          expect(sentAudio).toEqual([Buffer.from([0xfb, 0xff]), Buffer.from("valid")]),
        );
        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(errors).not.toHaveBeenCalled();
      } finally {
        ws.terminate();
      }
    });
  });
});

describe("MediaStreamHandler lifecycle", () => {
  it("rejects duplicate start frames without creating another STT session", async () => {
    const closeSession = vi.fn();
    const sttSession = { ...createStubSession(), close: closeSession };
    const createSession = vi.fn(() => sttSession);
    const shouldAcceptStream = vi.fn(() => true);
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const handler = createHandler({
      transcriptionProvider: createStubSttProvider(createSession),
      shouldAcceptStream,
      onConnect,
      onDisconnect,
    });
    await withConnection(handler, async (ws) => {
      sendStart(ws, "MZ-first", "CA-first");
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledWith("CA-first", "MZ-first"));

      sendStart(ws, "MZ-second", "CA-second");
      const closed = await waitForClose(ws);

      expect(closed).toEqual({ code: 1008, reason: "Duplicate start" });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(shouldAcceptStream).toHaveBeenCalledTimes(1);
      expect(onConnect).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(closeSession).toHaveBeenCalledTimes(1);
        expect(onDisconnect).toHaveBeenCalledExactlyOnceWith("CA-first", "MZ-first");
      });
    });
  });

  it("terminates active streams and shares concurrent close completion", async () => {
    const closeSession = vi.fn();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const handler = createAcceptedHandler(
      { ...createStubSession(), close: closeSession },
      { onConnect, onDisconnect },
    );
    const server = await startWsServer(handler);
    const ws = await connectWs(server.url);
    const shutdownBarrier = createDeferred<void>();

    try {
      sendStart(ws, "MZ-shutdown", "CA-shutdown");
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledWith("CA-shutdown", "MZ-shutdown"));

      const closed = waitForClose(ws);
      const firstClose = handler.close(shutdownBarrier.promise);
      const secondClose = handler.close();
      let closeSettled = false;
      void firstClose.then(() => {
        closeSettled = true;
      });

      expect(secondClose).toBe(firstClose);
      expect(await closed).toEqual({ code: 1006, reason: "" });
      await vi.waitFor(() => {
        expect(closeSession).toHaveBeenCalledTimes(1);
        expect(onDisconnect).toHaveBeenCalledExactlyOnceWith("CA-shutdown", "MZ-shutdown");
      });
      expect(closeSettled).toBe(false);

      shutdownBarrier.resolve();
      await firstClose;
      expect(closeSettled).toBe(true);
    } finally {
      shutdownBarrier.resolve();
      ws.terminate();
      await handler.close();
      await server.close();
    }
  });
});

const requireRecord = createRequireRecord("record", "expected-label-record");
const nextWsMessage = (ws: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(requireRecord(JSON.parse(rawDataToString(data)), "WebSocket message"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

function echoMark(ws: WebSocket, streamSid: string, name: string) {
  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name } }));
}

describe("MediaStreamHandler TTS queue", () => {
  it("completes queued playback only after Twilio echoes its mark", async () => {
    const onConnect = vi.fn();
    const handler = createHandler({ shouldAcceptStream: () => true, onConnect });
    await withConnection(handler, async (ws) => {
      sendStart(ws, "MZ-mark", "CA-mark");
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
      const outboundMark = nextWsMessage(ws);
      let completed = false;
      const playback = handler
        .queueTts("MZ-mark", async (signal) => {
          await handler.sendMarkAndWait("MZ-mark", "tts-complete", 100, signal);
        })
        .then(() => {
          completed = true;
        });
      expect(await withTimeout(outboundMark)).toMatchObject({
        event: "mark",
        mark: { name: "tts-complete" },
      });
      await Promise.resolve();
      expect(completed).toBe(false);

      echoMark(ws, "MZ-mark", "different-mark");
      const pong = once(ws, "pong");
      ws.ping();
      await withTimeout(pong);
      expect(completed).toBe(false);

      echoMark(ws, "MZ-mark", "tts-complete");
      await withTimeout(playback);
      expect(completed).toBe(true);
      await closeWs(ws);
    });
  });

  it("cancels active playback and clears queued items", async () => {
    const handler = createHandler();
    let queuedRan = false;
    const started: string[] = [];
    const active = handler.queueTts("stream-1", async (signal) => {
      started.push("active");
      await waitForAbort(signal);
    });
    const queued = handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    expect(started).toEqual(["active"]);
    handler.clearTtsQueue("stream-1");
    await active;
    await withTimeout(queued);
    expect(queuedRan).toBe(false);
  });

  it("bounds pending playback per stream and recovers after draining", async () => {
    const handler = createHandler();
    const activeGate = createDeferred<void>();
    const playbackOrder: number[] = [];

    const active = handler.queueTts("stream-1", async () => {
      playbackOrder.push(0);
      await activeGate.promise;
    });
    const pending = Array.from({ length: 8 }, (_, index) =>
      handler.queueTts("stream-1", async () => {
        playbackOrder.push(index + 1);
      }),
    );
    let overflowRan = false;

    await expect(
      handler.queueTts("stream-1", async () => {
        overflowRan = true;
      }),
    ).rejects.toThrow("Telephony TTS queue is full for stream; maxPending=8");

    await handler.queueTts("stream-2", async () => {});
    expect(overflowRan).toBe(false);
    expect(playbackOrder).toEqual([0]);

    activeGate.resolve();
    await active;
    await Promise.all(pending);
    expect(playbackOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    await handler.queueTts("stream-1", async () => {
      playbackOrder.push(9);
    });
    expect(playbackOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
