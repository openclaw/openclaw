// Voice Call tests cover media stream plugin behavior.
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { createTalkSessionController, type TalkEvent } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { MediaStreamHandler, type MediaStreamConfig } from "./media-stream.js";
import {
  connectWs,
  startUpgradeWsServer,
  waitForClose,
  withTimeout,
} from "./websocket-test-support.js";
import { WebSocket } from "./websocket.js";

const createStubSession = (): RealtimeTranscriptionSession => ({
  connect: async () => {},
  sendAudio: () => {},
  close: () => {},
  isConnected: () => true,
});

const createStubSttProvider = (
  createSession: RealtimeTranscriptionProviderPlugin["createSession"] = createStubSession,
): RealtimeTranscriptionProviderPlugin => ({
  createSession,
  id: "openai",
  label: "OpenAI",
  isConfigured: () => true,
});

const createHandler = (config: Partial<MediaStreamConfig> = {}) =>
  new MediaStreamHandler({
    transcriptionProvider: createStubSttProvider(),
    providerConfig: {},
    ...config,
  });

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const startWsServer = (handler: MediaStreamHandler) =>
  startUpgradeWsServer({
    urlPath: "/voice/stream",
    onUpgrade: (request, socket, head) => {
      handler.handleUpgrade(request, socket, head);
    },
  });

describe("MediaStreamHandler security hardening", () => {
  it("wraps malformed Twilio media stream JSON with an owned parser error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHandler();
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
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

      ws.close();
      await waitForClose(ws);
    } finally {
      errorSpy.mockRestore();
      await server.close();
    }
  });

  it("rejects start frames when no stream acceptance validator is configured", async () => {
    const createSession = vi.fn(() => createStubSession());
    const handler = createHandler({
      transcriptionProvider: createStubSttProvider(createSession),
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-unvalidated",
          start: { callSid: "CA-unvalidated" },
        }),
      );

      const closed = await waitForClose(ws);

      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe("Unauthorized stream");
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("emits common Talk events for telephony STT/TTS sessions", async () => {
    let callbacks: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sentAudio: Buffer[] = [];
    const session: RealtimeTranscriptionSession = {
      connect: async () => {},
      sendAudio: (audio) => {
        sentAudio.push(Buffer.from(audio));
      },
      close: () => {},
      isConnected: () => true,
    };
    const talkEvents: TalkEvent[] = [];
    const handler = createHandler({
      transcriptionProvider: createStubSttProvider((request) => {
        callbacks = request;
        return session;
      }),
      shouldAcceptStream: () => true,
      onTalkEvent: (_callId, _streamSid, event) => {
        talkEvents.push(event);
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-talk",
          start: { callSid: "CA-talk" },
        }),
      );
      await vi.waitFor(() => {
        expect(talkEvents.map((event) => event.type)).toContain("session.ready");
      });

      ws.send(
        JSON.stringify({
          event: "media",
          streamSid: "MZ-talk",
          media: { payload: Buffer.from("hello").toString("base64") },
        }),
      );
      await vi.waitFor(() => {
        expect(Buffer.concat(sentAudio).toString()).toBe("hello");
      });

      callbacks?.onSpeechStart?.();
      callbacks?.onPartial?.("hel");
      callbacks?.onTranscript?.("hello there");

      await handler.queueTts("MZ-talk", async () => {
        handler.sendAudio("MZ-talk", Buffer.alloc(160, 0xff));
      });

      const activePlayback = handler.queueTts("MZ-talk", async (signal) => {
        await waitForAbort(signal);
      });
      handler.clearTtsQueue("MZ-talk", "barge-in");
      await activePlayback;

      ws.close();
      await waitForClose(ws);
      await vi.waitFor(() => {
        expect(talkEvents.map((event) => event.type)).toContain("session.closed");
      });

      expect(talkEvents.map((event) => event.type)).toEqual([
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
      expect(talkEvents[0]).toMatchObject({
        sessionId: "voice-call:CA-talk:MZ-talk",
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        seq: 1,
      });
      expect(talkEvents.find((event) => event.type === "transcript.done")).toMatchObject({
        final: true,
        turnId: "MZ-talk:turn-1",
        payload: { text: "hello there", role: "user" },
      });
      expect(talkEvents.find((event) => event.type === "turn.cancelled")).toMatchObject({
        final: true,
        turnId: "MZ-talk:turn-2",
        payload: { reason: "barge-in" },
      });
    } finally {
      await server.close();
    }
  });

  it("fails sends and closes stream when buffered bytes already exceed the cap", () => {
    const handler = createHandler();
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 2 * 1024 * 1024,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    (
      handler as unknown as {
        sessions: Map<
          string,
          {
            callId: string;
            streamSid: string;
            ws: WebSocket;
            sttSession: RealtimeTranscriptionSession;
            talk: ReturnType<typeof createTalkSessionController>;
          }
        >;
      }
    ).sessions.set("MZ-backpressure", {
      callId: "CA-backpressure",
      streamSid: "MZ-backpressure",
      ws,
      sttSession: createStubSession(),
      talk: createTalkSessionController({
        sessionId: "voice-call:CA-backpressure:MZ-backpressure",
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
      }),
    });

    const result = handler.sendAudio("MZ-backpressure", Buffer.alloc(160, 0xff));

    expect(result).toBe(false);
    expect(ws["send"]).not.toHaveBeenCalled();
    expect(ws["close"]).toHaveBeenCalledWith(1013, "Backpressure: send buffer exceeded");
  });

  it("fails sends when buffered bytes exceed cap after enqueueing a frame", () => {
    const handler = createHandler();
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(() => {
        (
          ws as unknown as {
            bufferedAmount: number;
          }
        ).bufferedAmount = 2 * 1024 * 1024;
      }),
      close: vi.fn(),
    } as unknown as WebSocket;
    (
      handler as unknown as {
        sessions: Map<
          string,
          {
            callId: string;
            streamSid: string;
            ws: WebSocket;
            sttSession: RealtimeTranscriptionSession;
          }
        >;
      }
    ).sessions.set("MZ-overflow", {
      callId: "CA-overflow",
      streamSid: "MZ-overflow",
      ws,
      sttSession: createStubSession(),
    });

    const result = handler.sendMark("MZ-overflow", "mark-1");

    expect(ws["send"]).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
    expect(ws["close"]).toHaveBeenCalledWith(1013, "Backpressure: send buffer exceeded");
  });

  it("sanitizes websocket close reason before logging", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = createHandler();
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.close(1000, "forged\nline\r\tentry");
      await waitForClose(ws);
      await vi.waitFor(() => {
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("reason: forged line entry"));
      });
      const line = logSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes("WebSocket closed"));
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\r");
      expect(line).not.toContain("\t");
    } finally {
      logSpy.mockRestore();
      await server.close();
    }
  });

  it("truncates websocket close reason without splitting UTF-16 surrogate pairs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = createHandler();
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.close(1000, `${"a".repeat(119)}\uD83D\uDE80`);
      await waitForClose(ws);
      await vi.waitFor(() => {
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining(`reason: ${"a".repeat(119)}...`),
        );
      });
      const line = logSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes("WebSocket closed"));
      expect(line).not.toContain("\uD83D");
      expect(line).not.toContain("\uDE80");
    } finally {
      logSpy.mockRestore();
      await server.close();
    }
  });

  it("closes idle pre-start connections after timeout", async () => {
    const shouldAcceptStreamCalls: Array<{ callId: string; streamSid: string; token?: string }> =
      [];
    const handler = createHandler({
      preStartTimeoutMs: 40,
      shouldAcceptStream: (params) => {
        shouldAcceptStreamCalls.push(params);
        return true;
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      const closed = await waitForClose(ws);

      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe("Start timeout");
      expect(shouldAcceptStreamCalls).toStrictEqual([]);
    } finally {
      await server.close();
    }
  });

  it("clamps oversized pre-start connection timeouts", () => {
    vi.useFakeTimers();
    try {
      const handler = createHandler({
        preStartTimeoutMs: Number.MAX_SAFE_INTEGER,
      });
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
    const server = await startWsServer(handler);

    try {
      const first = await connectWs(server.url);
      const second = await connectWs(server.url);
      const secondClosed = await waitForClose(second);

      expect(secondClosed.code).toBe(1013);
      expect(secondClosed.reason).toContain("Too many pending");
      expect(first.readyState).toBe(WebSocket.OPEN);

      first.close();
      await waitForClose(first);
    } finally {
      await server.close();
    }
  });

  it("uses resolved client IPs for per-IP pending limits", async () => {
    const handler = createHandler({
      preStartTimeoutMs: 5_000,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 1,
      resolveClientIp: (request) => String(request.headers["x-forwarded-for"] ?? ""),
    });
    const server = await startWsServer(handler);

    try {
      const first = new WebSocket(server.url, {
        headers: { "x-forwarded-for": "198.51.100.10" },
      });
      await withTimeout(
        new Promise((resolve) => {
          first.once("open", resolve);
        }),
      );

      const second = new WebSocket(server.url, {
        headers: { "x-forwarded-for": "203.0.113.20" },
      });
      await withTimeout(
        new Promise((resolve) => {
          second.once("open", resolve);
        }),
      );

      expect(first.readyState).toBe(WebSocket.OPEN);
      expect(second.readyState).toBe(WebSocket.OPEN);

      const firstClosed = waitForClose(first);
      const secondClosed = waitForClose(second);
      first.close();
      second.close();
      await firstClosed;
      await secondClosed;
    } finally {
      await server.close();
    }
  });

  it("rejects upgrades when max connection cap is reached", async () => {
    const handler = createHandler({
      preStartTimeoutMs: 5_000,
      maxConnections: 1,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    const server = await startWsServer(handler);

    try {
      const first = await connectWs(server.url);
      const secondError = await withTimeout(
        new Promise<Error>((resolve) => {
          const ws = new WebSocket(server.url);
          ws.once("error", (err) => resolve(err));
        }),
      );

      expect(secondError.message).toContain("Unexpected server response: 503");

      first.close();
      await waitForClose(first);
    } finally {
      await server.close();
    }
  });

  it("counts in-flight upgrades against the max connection cap", () => {
    const handler = createHandler({
      maxConnections: 2,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });

    const fakeWss = {
      clients: new Set([{}]),
      handleUpgrade: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
    };
    let upgradeCallback: ((ws: WebSocket) => void) | null = null;
    fakeWss.handleUpgrade.mockImplementation(
      (
        _request: IncomingMessage,
        _socket: unknown,
        _head: Buffer,
        callback: (ws: WebSocket) => void,
      ) => {
        upgradeCallback = callback;
      },
    );

    (
      handler as unknown as {
        wss: typeof fakeWss;
      }
    ).wss = fakeWss;

    const firstSocket = {
      once: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    };
    handler.handleUpgrade(
      { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      firstSocket as never,
      Buffer.alloc(0),
    );

    const secondSocket = {
      once: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    };
    handler.handleUpgrade(
      { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      secondSocket as never,
      Buffer.alloc(0),
    );

    expect(fakeWss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(secondSocket.write).toHaveBeenCalledOnce();
    expect(secondSocket.destroy).toHaveBeenCalledOnce();

    const completeUpgrade = upgradeCallback as ((ws: WebSocket) => void) | null;
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
    const server = await startWsServer(handler);
    const serverUrl = new URL(server.url);

    try {
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

      const ws = await connectWs(server.url);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });

  it("clears pending state after valid start", async () => {
    const shouldAcceptStream = vi.fn(
      (_params: { callId: string; streamSid: string; token?: string }) => true,
    );
    const handler = createHandler({
      maxPendingConnections: 1,
      maxPendingConnectionsPerIp: 10,
      preStartTimeoutMs: 5_000,
      shouldAcceptStream,
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ123",
          start: { callSid: "CA123", customParameters: { token: "token-123" } },
        }),
      );

      await vi.waitFor(() => {
        expect(shouldAcceptStream).toHaveBeenCalledOnce();
      });
      expect(shouldAcceptStream).toHaveBeenCalledWith({
        callId: "CA123",
        streamSid: "MZ123",
        token: "token-123",
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);

      const second = await connectWs(server.url);
      expect(second.readyState).toBe(WebSocket.OPEN);

      second.close();
      await waitForClose(second);
      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });

  it("forwards early Twilio media into the STT session before readiness", async () => {
    const sttReady = createDeferred<void>();
    const sttConnectStarted = createDeferred<void>();
    const transcriptionReady = createDeferred<void>();
    const audioReceived = createDeferred<void>();
    const receivedAudio: Buffer[] = [];
    let onConnectCalls = 0;
    let onTranscriptionReadyCalls = 0;

    const session: RealtimeTranscriptionSession = {
      connect: async () => {
        expect(onConnectCalls).toBe(1);
        sttConnectStarted.resolve();
        await sttReady.promise;
      },
      sendAudio: (audio) => {
        receivedAudio.push(Buffer.from(audio));
        audioReceived.resolve();
      },
      close: () => {},
      isConnected: () => false,
    };

    const handler = createHandler({
      transcriptionProvider: createStubSttProvider(() => session),
      shouldAcceptStream: () => true,
      onConnect: () => {
        onConnectCalls += 1;
      },
      onTranscriptionReady: () => {
        onTranscriptionReadyCalls += 1;
        transcriptionReady.resolve();
      },
    });
    const server = await startWsServer(handler);
    let ws: WebSocket | undefined;

    try {
      ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-early-media",
          start: { callSid: "CA-early-media" },
        }),
      );

      await withTimeout(sttConnectStarted.promise);
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid: "MZ-early-media",
          media: { payload: Buffer.from("early").toString("base64") },
        }),
      );
      await withTimeout(audioReceived.promise);

      expect(Buffer.concat(receivedAudio).toString()).toBe("early");
      expect(onConnectCalls).toBe(1);
      expect(onTranscriptionReadyCalls).toBe(0);

      sttReady.resolve();
      await withTimeout(transcriptionReady.promise);
      expect(onConnectCalls).toBe(1);
      expect(onTranscriptionReadyCalls).toBe(1);
    } finally {
      sttReady.resolve();
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        if (ws.readyState !== WebSocket.CLOSED) {
          await waitForClose(ws).catch(() => {});
        }
      }
      await server.close();
    }
  });

  it("closes the media stream and disconnects once when STT readiness fails", async () => {
    const sttConnectStarted = createDeferred<void>();
    const onDisconnectReady = createDeferred<void>();
    const onConnect = vi.fn();
    const onTranscriptionReady = vi.fn();
    const onDisconnect = vi.fn(() => {
      onDisconnectReady.resolve();
    });

    const session: RealtimeTranscriptionSession = {
      connect: async () => {
        sttConnectStarted.resolve();
        throw new Error("provider unavailable");
      },
      sendAudio: () => {},
      close: vi.fn(),
      isConnected: () => false,
    };

    const handler = createHandler({
      transcriptionProvider: createStubSttProvider(() => session),
      shouldAcceptStream: () => true,
      onConnect,
      onTranscriptionReady,
      onDisconnect,
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-stt-fail",
          start: { callSid: "CA-stt-fail" },
        }),
      );

      await withTimeout(sttConnectStarted.promise);
      const closed = await waitForClose(ws);
      await withTimeout(onDisconnectReady.promise);

      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe("STT connection failed");
      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(onConnect).toHaveBeenCalledWith("CA-stt-fail", "MZ-stt-fail");
      expect(onTranscriptionReady).not.toHaveBeenCalled();
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      expect(onDisconnect).toHaveBeenCalledWith("CA-stt-fail", "MZ-stt-fail");
      expect(session["close"]).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("rejects oversized pre-start frames at the websocket maxPayload guard before validation runs", async () => {
    const shouldAcceptStreamCalls: Array<{ callId: string; streamSid: string; token?: string }> =
      [];
    const handler = createHandler({
      preStartTimeoutMs: 1_000,
      shouldAcceptStream: (params) => {
        shouldAcceptStreamCalls.push(params);
        return true;
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-oversized",
          start: {
            callSid: "CA-oversized",
            customParameters: { token: "token-oversized", padding: "A".repeat(256 * 1024) },
          },
        }),
      );

      const closed = await waitForClose(ws);

      expect(closed.code).toBe(1009);
      expect(shouldAcceptStreamCalls).toStrictEqual([]);
    } finally {
      await server.close();
    }
  });
});
