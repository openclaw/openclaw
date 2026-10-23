import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSocketTransport } from "./transport-websocket.js";

const state = vi.hoisted(() => ({ socket: undefined as EventEmitter | undefined }));
vi.mock("openclaw/plugin-sdk/websocket-runtime", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    WebSocket: class extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 3;
      static CLOSING = 2;
      readyState = 0;
      constructor() {
        super();
        state.socket = this;
      }
      close() {
        this.readyState = 3;
        this.emit("close", 1000, Buffer.alloc(0));
      }
      terminate() {
        this.close();
      }
      send() {}
    },
  };
});

afterEach(() => {
  state.socket = undefined;
});

describe("WebSocket startup failure boundary", () => {
  it.each([
    ["ECONNREFUSED", "connect refused", false, true],
    ["ECONNRESET", "socket hang up", false, true],
    [undefined, "Opening handshake has timed out", false, true],
    [undefined, "Unexpected server response: 401", false, false],
    [undefined, "Unexpected server response: 403", false, false],
    ["CERT_HAS_EXPIRED", "certificate expired", false, false],
    ["ECONNRESET", "socket hang up", true, false],
  ])("classifies %s / %s with opened=%s", (code, message, opened, retryable) => {
    const transport = createWebSocketTransport({
      transport: "websocket",
      url: "ws://example.invalid",
      command: "codex",
      args: ["app-server"],
      headers: {},
    });
    const errors: unknown[] = [];
    transport.once("error", (error) => errors.push(error));
    try {
      if (opened) {
        state.socket!.emit("open");
      }
      const original = Object.assign(new Error(message), { code });
      state.socket!.emit("error", original);
      expect(errors).toHaveLength(1);
      if (retryable) {
        expect(errors[0]).toMatchObject({
          code: "CODEX_APP_SERVER_WEBSOCKET_OPEN_FAILED",
          cause: original,
        });
      } else {
        expect(errors[0]).toBe(original);
      }
    } finally {
      transport.kill?.();
      transport.stdin.destroy?.();
      transport.stdout.destroy?.();
      transport.stderr.destroy?.();
    }
  });
});
