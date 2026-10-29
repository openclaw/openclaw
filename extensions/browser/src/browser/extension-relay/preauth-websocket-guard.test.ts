import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Duplex, type DuplexOptions } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { handlePreAuthWebSocketUpgrade } from "./preauth-websocket-guard.js";
import { EXTENSION_RELAY_MAX_PAYLOAD_BYTES } from "./relay-server.js";

afterEach(() => vi.restoreAllMocks());

function upgradeFixture(write: DuplexOptions["write"]) {
  const socket = new Duplex({ read() {}, write });
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/extension";
  req.headers = {
    host: "127.0.0.1",
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: EXTENSION_RELAY_MAX_PAYLOAD_BYTES,
  });
  onTestFinished(async () => {
    for (const client of wss.clients) {
      client.terminate();
    }
    socket.destroy();
    req.destroy();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  });
  return { wss, req, socket };
}

describe("pre-auth WebSocket head admission", () => {
  it("rejects oversized upgrade-head auth data before challenge or bridge promotion", async () => {
    let writtenBytes = 0;
    const fixture = upgradeFixture((chunk: Buffer, _encoding, callback) => {
      writtenBytes += chunk.byteLength;
      callback();
    });
    const handleUpgrade = vi.spyOn(fixture.wss, "handleUpgrade");
    const onUpgrade = vi.fn((ws: WebSocket) => ws.on("error", () => {}));
    // Supply Node's exact head argument: client TCP writes cannot choose its size.
    const head = Buffer.alloc(17 * 1024 + 1);
    expect(handlePreAuthWebSocketUpgrade({ ...fixture, head, onUpgrade })).toBe(false);
    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(fixture.wss.clients.size).toBe(0);
    expect(writtenBytes).toBe(0);
  });

  it.each([false, true])(
    "owns a pending raw write error through close (terminated=%s)",
    async (terminated) => {
      let pendingWrite: ((error?: Error | null) => void) | undefined;
      const fixture = upgradeFixture((chunk: Buffer, _encoding, callback) => {
        if (chunk.toString().startsWith("HTTP/1.1")) {
          callback();
        } else {
          pendingWrite = callback;
        }
      });
      const { socket } = fixture;
      const rawClosed = vi.fn();
      socket.once("close", rawClosed);
      const writeResult = vi.fn();
      let closeWebSocket = () => {};
      const closed = new Promise<void>((resolve) => {
        handlePreAuthWebSocketUpgrade({
          ...fixture,
          head: Buffer.alloc(0),
          onUpgrade: (ws) => {
            ws.once("close", () => resolve());
            closeWebSocket = () => ws.terminate();
            ws.send("pending reply", writeResult);
          },
        });
      });
      await setImmediate();
      expect(pendingWrite).toBeTypeOf("function");
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      // Node can deliver the write callback before the raw socket's queued
      // error event. Destroying the wrapper must not orphan that event.
      process.nextTick(() => pendingWrite?.(error));
      socket.destroy(error);
      if (terminated) {
        closeWebSocket();
      }
      await closed;
      await setImmediate();
      expect(writeResult).toHaveBeenCalledExactlyOnceWith(error);
      expect(rawClosed).toHaveBeenCalledOnce();
      expect(["data", "end", "error"].map((event) => socket.listenerCount(event))).toEqual([
        0, 0, 0,
      ]);
      expect(fixture.wss.clients.size).toBe(0);
    },
  );
});
