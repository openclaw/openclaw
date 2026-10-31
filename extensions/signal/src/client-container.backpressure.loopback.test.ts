// Real-TCP receive backpressure: a valid burst against a held durable admission.
import { once } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ClientOptions } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { streamContainerEvents } from "./client-container.js";

const clients = vi.hoisted(() => [] as WebSocket[]);
const decoded = vi.hoisted(() => ({ count: 0 }));
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  return {
    ...actual,
    WebSocket: class extends actual.WebSocket {
      constructor(address: string, options?: ClientOptions) {
        super(address, options);
        clients.push(this);
        this.on("message", () => decoded.count++);
      }
    },
  };
});

// Valid sub-limit frames, ~16 MB in all: more than loopback socket buffers hold,
// so the peer keeps unsent frames while the client is paused.
const BURST = 512;
const frame = (timestamp: number) =>
  JSON.stringify({ envelope: { timestamp, dataMessage: { message: "x".repeat(32_000) } } });

async function startPeer(onConnection: (ws: WebSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const connected = once(server, "connection").then(([ws]) => ws as WebSocket);
  server.on("connection", onConnection);
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    connected,
    close: async () => {
      server.clients.forEach((ws) => ws.terminate());
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe("container receive backpressure with a real peer", () => {
  let peer: Awaited<ReturnType<typeof startPeer>> | undefined;

  afterEach(async () => {
    await peer?.close();
    peer = undefined;
    clients.length = 0;
    decoded.count = 0;
  });

  it("stops reading while admission is held and delivers the burst in order on shutdown", async () => {
    peer = await startPeer((ws) => {
      for (let i = 1; i <= BURST; i++) {
        ws.send(frame(i));
      }
    });
    const held = createDeferred<void>();
    const admitting = createDeferred<void>();
    const delivered: number[] = [];
    const abort = new AbortController();
    const stream = streamContainerEvents({
      baseUrl: peer.baseUrl,
      abortSignal: abort.signal,
      onEvent: async (event) => {
        delivered.push(event.envelope?.timestamp ?? 0);
        if (delivered.length === 1) {
          admitting.resolve();
          await held.promise;
        }
      },
    });

    await admitting.promise;
    // Progress fence: a free reader on the same loopback and event loop takes a
    // whole burst after the client started; an unpaused client keeps pace with it.
    const reader = new WebSocket(peer.baseUrl.replace(/^http/, "ws"));
    await new Promise<void>((resolve) => {
      let received = 0;
      reader.on("message", () => {
        if (++received === BURST) {
          resolve();
        }
      });
    });
    reader.terminate();
    expect((await peer.connected).bufferedAmount).toBeGreaterThan(0);
    expect(decoded.count).toBeLessThan(BURST);
    expect(clients[0]?.isPaused).toBe(true);
    abort.abort();
    held.resolve();
    await stream;

    expect(delivered).toEqual(Array.from({ length: BURST }, (_, i) => i + 1));
  });

  // Without resuming, the peer only drops the paused socket after ws's 30 s close timeout.
  it("closes the paused socket when a receive handler fails", { timeout: 5_000 }, async () => {
    peer = await startPeer((ws) => {
      for (let i = 1; i <= BURST; i++) {
        ws.send(frame(i));
      }
    });
    const error = new Error("durable append failed");
    const stream = streamContainerEvents({
      baseUrl: peer.baseUrl,
      onEvent: () => Promise.reject(error),
    });
    const peerClosed = peer.connected.then((ws) => once(ws, "close"));

    await expect(stream).rejects.toBe(error);
    const [code] = await peerClosed;
    expect(code).toBe(1005);
  });
});
