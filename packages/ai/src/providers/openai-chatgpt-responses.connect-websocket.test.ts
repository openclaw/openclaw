// Covers the WebSocket handshake timeout in connectWebSocket.
// Uses vi.useFakeTimers() to fast-forward past the deadline without waiting.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectWebSocketForTest,
  resetOpenAICodexWebSocketStateForTest,
} from "./openai-chatgpt-responses.js";

function mockNeverOpenWebSocket(): {
  getCloseCode: () => number | undefined;
  getCloseReason: () => string | undefined;
} {
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  class NeverOpenWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = NeverOpenWebSocket.CONNECTING;
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    addEventListener(event: string, listener: (...args: unknown[]) => void): void {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)?.add(listener);
    }

    removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
      this.listeners.get(event)?.delete(listener);
    }

    close(code: number, reason: string): void {
      closeCode = code;
      closeReason = reason;
      this.readyState = NeverOpenWebSocket.CLOSED;
    }
  }

  vi.stubGlobal("WebSocket", NeverOpenWebSocket as unknown);
  return { getCloseCode: () => closeCode, getCloseReason: () => closeReason };
}

describe("connectWebSocket handshake timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetOpenAICodexWebSocketStateForTest();
  });

  it("applies default 30s timer when no handshakeTimeoutMs is specified", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockNeverOpenWebSocket();

      const wsPromise = connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
      );

      const rejected = expect(wsPromise).rejects.toThrow(
        "WebSocket connection to OpenAI Responses API timed out after 30000ms",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;

      expect(mock.getCloseCode()).toBe(1000);
      expect(mock.getCloseReason()).toBe("handshake_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses caller-specified handshakeTimeoutMs when provided", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockNeverOpenWebSocket();

      const wsPromise = connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
        undefined,
        5_000,
      );

      const rejected = expect(wsPromise).rejects.toThrow(
        "WebSocket connection to OpenAI Responses API timed out after 5000ms",
      );
      // Timer fires at 5s instead of 30s.
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;

      expect(mock.getCloseCode()).toBe(1000);
      expect(mock.getCloseReason()).toBe("handshake_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("timer still fires when a cancellation signal is present", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockNeverOpenWebSocket();
      const controller = new AbortController();

      const wsPromise = connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
        controller.signal,
      );

      // Advance 30s without aborting — timer fires via handshake timeout.
      const rejected = expect(wsPromise).rejects.toThrow(
        "WebSocket connection to OpenAI Responses API timed out after 30000ms",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;

      expect(mock.getCloseCode()).toBe(1000);
      expect(mock.getCloseReason()).toBe("handshake_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves normally when WebSocket opens before timeout", async () => {
    vi.useFakeTimers();
    try {
      class InstantOpenWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = InstantOpenWebSocket.CONNECTING;
        private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

        addEventListener(event: string, listener: (...args: unknown[]) => void): void {
          if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
          }
          this.listeners.get(event)?.add(listener);
          if (event === "open") {
            this.readyState = InstantOpenWebSocket.OPEN;
            listener();
          }
        }

        removeEventListener(): void {}
        close(): void {}
      }

      vi.stubGlobal("WebSocket", InstantOpenWebSocket as unknown);

      const ws = await connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
      );

      expect(ws).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with error when WebSocket errors before timeout", async () => {
    vi.useFakeTimers();
    try {
      class ErrorWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = ErrorWebSocket.CONNECTING;
        private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        private errorEvent = { error: new Error("connection refused") };

        addEventListener(event: string, listener: (...args: unknown[]) => void): void {
          if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
          }
          this.listeners.get(event)?.add(listener);
          if (event === "error") {
            listener(this.errorEvent);
          }
        }

        removeEventListener(): void {}
        close(): void {}
      }

      vi.stubGlobal("WebSocket", ErrorWebSocket as unknown);

      await expect(
        connectWebSocketForTest(
          "wss://responses.openai.com/ws",
          new Headers({ Authorization: "Bearer test" }),
        ),
      ).rejects.toThrow("connection refused");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with abort error when signal aborts before timeout", async () => {
    vi.useFakeTimers();
    try {
      mockNeverOpenWebSocket();

      const controller = new AbortController();
      controller.abort();

      await expect(
        connectWebSocketForTest(
          "wss://responses.openai.com/ws",
          new Headers({ Authorization: "Bearer test" }),
          controller.signal,
        ),
      ).rejects.toThrow("Request was aborted");
    } finally {
      vi.useRealTimers();
    }
  });
});
