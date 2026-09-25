// Voice Call tests cover media-stream upgrade rejection / connection-cap behavior.
import { once } from "node:events";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it, vi } from "vitest";
import { MediaStreamHandler } from "./media-stream.js";
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

const createStubSttProvider = (): RealtimeTranscriptionProviderPlugin =>
  ({
    createSession: () => createStubSession(),
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
  }) as unknown as RealtimeTranscriptionProviderPlugin;

const startWsServer = async (
  handler: MediaStreamHandler,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> =>
  startUpgradeWsServer({
    urlPath: "/voice/stream",
    onUpgrade: (request, socket, head) => {
      handler.handleUpgrade(request, socket, head);
    },
  });

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
};

describe("MediaStreamHandler upgrade rejection", () => {
  it("rejects upgrades when max connection cap is reached", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
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

  it("flushes shutdown upgrade rejection bytes before destroying the socket", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });
    let releaseShutdownBarrier: (() => void) | undefined;
    const shutdownBarrier = new Promise<void>((resolve) => {
      releaseShutdownBarrier = resolve;
    });
    const closePromise = handler.close(shutdownBarrier);

    let response = "";
    let flush = () => {};
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        response += chunk.toString();
        flush = callback;
      },
    });
    const closed = once(socket, "close");
    handler.handleUpgrade({} as IncomingMessage, socket, Buffer.alloc(0));

    expect(response).toBe(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength("Media stream handler is shutting down\n")}\r\n` +
        "\r\n" +
        "Media stream handler is shutting down\n",
    );
    expect(socket.destroyed).toBe(false);
    flush();
    await closed;
    expect(socket.destroyed).toBe(true);

    releaseShutdownBarrier?.();
    await closePromise;
  });

  it("counts in-flight upgrades against the max connection cap", () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
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
      end: vi.fn(),
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
      end: vi.fn((response: string, callback?: () => void) => {
        callback?.();
        return secondSocket;
      }),
      destroy: vi.fn(),
    };
    handler.handleUpgrade(
      { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      secondSocket as never,
      Buffer.alloc(0),
    );

    expect(fakeWss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(secondSocket.end).toHaveBeenCalledOnce();
    const endArgs = expectDefined(secondSocket.end.mock.calls.at(0), "upgrade reject end call");
    expect(endArgs[0]).toEqual(expect.stringContaining("HTTP/1.1 503 Service Unavailable"));
    expect(endArgs[0]).toEqual(expect.stringContaining("Too many media stream connections"));
    expect(secondSocket.destroy).toHaveBeenCalledOnce();

    const completeUpgrade = upgradeCallback as ((ws: WebSocket) => void) | null;
    if (!completeUpgrade) {
      throw new Error("Expected upgrade callback to be registered");
    }
    completeUpgrade({} as WebSocket);
    expect(fakeWss.emit).toHaveBeenCalledOnce();
    const emitCall = expectDefined(fakeWss.emit.mock.calls.at(0), "websocket connection emit call");
    expect(emitCall[0]).toBe("connection");
    if (!emitCall[1]) {
      throw new Error("Expected websocket connection argument");
    }
    const request = requireRecord(emitCall[2], "connection request");
    const socket = requireRecord(request.socket, "connection request socket");
    expect(socket.remoteAddress).toBe("127.0.0.1");
  });

  it("returns HTTP 503 over a real upgrade when the connection cap is reached", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      maxConnections: 0,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    const server = await startWsServer(handler);
    try {
      const url = new URL(server.url);
      const result = await withTimeout(
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request(
            {
              hostname: url.hostname,
              port: url.port,
              path: url.pathname,
              method: "GET",
              headers: {
                connection: "Upgrade",
                upgrade: "websocket",
              },
            },
            (res) => {
              res.setEncoding("utf8");
              let body = "";
              res.on("data", (chunk) => {
                body += chunk;
              });
              res.on("end", () => {
                resolve({ status: res.statusCode ?? 0, body });
              });
            },
          );
          req.on("error", reject);
          req.end();
        }),
      );
      expect(result.status).toBe(503);
      expect(result.body).toContain("Too many media stream connections");
    } finally {
      await server.close();
    }
  });

  it("does not surface uncaught errors when the peer resets during a 503 reject", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      maxConnections: 0,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    let client: net.Socket | undefined;
    let markRejectionStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markRejectionStarted = resolve;
    });
    const server = await startUpgradeWsServer({
      urlPath: "/voice/stream",
      onUpgrade: (request, socket, head) => {
        const originalEnd = socket.end.bind(socket);
        socket.end = ((chunk?: unknown, encodingOrCb?: unknown, cb?: unknown) => {
          const onFlushed = typeof encodingOrCb === "function" ? encodingOrCb : cb;
          client?.destroy();
          markRejectionStarted();
          return originalEnd(chunk as string, () => {
            if (typeof onFlushed === "function") {
              onFlushed();
            }
          });
        }) as typeof socket.end;
        handler.handleUpgrade(request, socket, head);
      },
    });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    try {
      const url = new URL(server.url);
      client = net.connect({ host: url.hostname, port: Number(url.port) });
      await new Promise<void>((resolve, reject) => {
        client?.once("connect", resolve);
        client?.once("error", reject);
      });
      client.write(
        `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      await started;
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(uncaught).toEqual([]);
      console.log(`[media-stream rst proof] rejection_started=true uncaught=${uncaught.length}`);
    } finally {
      process.off("uncaughtException", onUncaught);
      await server.close();
    }
  });

  it("flushes a buffered 503 over real transport after an injected hold", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      maxConnections: 0,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    let releaseFlush: (() => void) | undefined;
    const flushHeld = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let rejectPending = false;
    const server = await startUpgradeWsServer({
      urlPath: "/voice/stream",
      onUpgrade: (request, socket, head) => {
        const originalEnd = socket.end.bind(socket);
        socket.end = ((chunk?: unknown, encodingOrCb?: unknown, cb?: unknown) => {
          const onFlushed = typeof encodingOrCb === "function" ? encodingOrCb : cb;
          rejectPending = true;
          void flushHeld.then(() => {
            originalEnd(chunk as string, () => {
              if (typeof onFlushed === "function") {
                onFlushed();
              }
            });
          });
          return socket;
        }) as typeof socket.end;
        handler.handleUpgrade(request, socket, head);
      },
    });
    try {
      const url = new URL(server.url.replace(/^ws:/, "http:"));
      const resultPromise = withTimeout(
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request(
            {
              hostname: url.hostname,
              port: url.port,
              path: url.pathname,
              method: "GET",
              headers: {
                connection: "Upgrade",
                upgrade: "websocket",
              },
            },
            (res) => {
              res.setEncoding("utf8");
              let body = "";
              res.on("data", (chunk) => {
                body += chunk;
              });
              res.on("end", () => {
                resolve({ status: res.statusCode ?? 0, body });
              });
            },
          );
          req.on("error", reject);
          req.end();
        }),
        3_000,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(rejectPending).toBe(true);
      releaseFlush?.();
      const result = await resultPromise;
      expect(result.status).toBe(503);
      expect(result.body).toContain("Too many media stream connections");
      console.log(
        `[media-stream buffered transport proof] pending_before_release=true status=${result.status} body=${result.body.trim()}`,
      );
    } finally {
      releaseFlush?.();
      await server.close();
    }
  });

  it("releases in-flight reservations when ws rejects a malformed upgrade before the callback", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
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
});
