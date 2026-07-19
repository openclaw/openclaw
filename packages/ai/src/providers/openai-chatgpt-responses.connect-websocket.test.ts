// Covers the 30s WebSocket handshake timeout added in connectWebSocket.
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
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
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

  it("rejects with timeout error when WebSocket never completes handshake", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockNeverOpenWebSocket();

      const wsPromise = connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
      );

      // Await the rejection expectation — store ahead so it is registered
      // before the timer callback fires.
      const rejected = expect(wsPromise).rejects.toThrow(
        "WebSocket connection to OpenAI Responses API timed out after 30000ms",
      );

      // Fast-forward past the 30s handshake deadline.
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;

      // Verify the socket was closed with the handshake_timeout reason.
      expect(mock.getCloseCode()).toBe(1000);
      expect(mock.getCloseReason()).toBe("handshake_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not apply 30s timer when signal is provided, defers to caller's signal", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockNeverOpenWebSocket();
      const controller = new AbortController();

      const wsPromise = connectWebSocketForTest(
        "wss://responses.openai.com/ws",
        new Headers({ Authorization: "Bearer test" }),
        controller.signal,
      );

      // Advance past 30s — the handshake timer was NOT set because a
      // caller signal was provided, so close() should not have been called.
      vi.advanceTimersByTime(30_000);
      expect(mock.getCloseCode()).toBeUndefined();
      expect(mock.getCloseReason()).toBeUndefined();

      // Now abort via the caller's signal to settle the promise.
      controller.abort();

      let caught: Error | undefined;
      try {
        await wsPromise;
      } catch (error) {
        caught = error instanceof Error ? error : new Error(String(error));
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toBe("Request was aborted");
      expect(mock.getCloseCode()).toBe(1000);
      expect(mock.getCloseReason()).toBe("aborted");
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
          if (!this.listeners.has(event)) this.listeners.set(event, new Set());
          this.listeners.get(event)!.add(listener);
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
          if (!this.listeners.has(event)) this.listeners.set(event, new Set());
          this.listeners.get(event)!.add(listener);
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
