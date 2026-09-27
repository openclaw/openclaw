import * as fetchModule from "openclaw/plugin-sdk/fetch-runtime";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { containerCheck, streamContainerEvents } from "./client-container.js";

const mockFetch = vi.fn();
const wsMockState = vi.hoisted(() => ({
  behavior: "close" as
    | "close"
    | "open"
    | "error"
    | "message"
    | "buffered-message"
    | "pending"
    | "unexpected-response",
  urls: [] as string[],
  options: [] as Array<{ maxPayload?: number; handshakeTimeout?: number } | undefined>,
  terminations: 0,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(fetchModule, "resolveFetch").mockReturnValue(mockFetch as unknown as typeof fetch);
  wsMockState.behavior = "close";
  wsMockState.urls = [];
  wsMockState.options = [];
  wsMockState.terminations = 0;
});

function expectMockLogNotContains(mock: ReturnType<typeof vi.fn>, expected: string): void {
  const messages = mock.mock.calls.map((call) => String(call[0] ?? ""));
  expect(messages.join("\n")).not.toContain(expected);
}

// Minimal WebSocket mock for connection-log assertions.
vi.mock("./ws-runtime.js", () => ({
  WebSocket: class MockWebSocket {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    private bufferedMessageFlushed = false;

    constructor(url: string | URL, options?: { maxPayload?: number; handshakeTimeout?: number }) {
      wsMockState.urls.push(String(url));
      wsMockState.options.push(options);
      setTimeout(() => {
        if (wsMockState.behavior === "open") {
          this.emit("open");
          this.emit("close", 1000, Buffer.from("done"));
        } else if (wsMockState.behavior === "error") {
          this.emit("error", new Error("WebSocket failed"));
        } else if (wsMockState.behavior === "unexpected-response") {
          this.emit("unexpected-response", {}, { statusCode: 200, statusMessage: "OK" });
        } else if (wsMockState.behavior === "message") {
          this.emit("message", Buffer.from('{"envelope":{"timestamp":1}}'));
          this.emit("close", 1000, Buffer.from("done"));
        } else if (wsMockState.behavior === "buffered-message") {
          this.emit("open");
          this.emit("message", Buffer.from('{"envelope":{"timestamp":1}}'));
        } else if (wsMockState.behavior === "pending") {
          // Keep the opening handshake unresolved until shutdown closes it.
        } else {
          this.emit("close", 1000, Buffer.from("done"));
        }
      }, 0);
    }

    on(event: string, callback: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(callback);
      this.handlers.set(event, handlers);
      return this;
    }

    once(event: string, callback: (...args: unknown[]) => void) {
      const onceCallback = (...args: unknown[]) => {
        this.handlers.set(
          event,
          (this.handlers.get(event) ?? []).filter((handler) => handler !== onceCallback),
        );
        callback(...args);
      };
      return this.on(event, onceCallback);
    }

    close() {
      if (wsMockState.behavior === "buffered-message" && !this.bufferedMessageFlushed) {
        this.bufferedMessageFlushed = true;
        // ws flushes already-buffered receiver frames before its final close event.
        this.emit("message", Buffer.from('{"envelope":{"timestamp":2}}'));
      }
      this.emit("close", 1000, Buffer.from("done"));
    }

    terminate() {
      wsMockState.terminations += 1;
    }

    private emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  },
}));

describe("containerCheck", () => {
  it("validates the receive WebSocket when an account is provided", async () => {
    wsMockState.behavior = "open";
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await containerCheck("http://localhost:8080", 1000, "+14259798283");

    expect(result).toEqual({ ok: true, status: 101, error: null });
    expect(wsMockState.urls).toEqual(["ws://localhost:8080/v1/receive/%2B14259798283"]);
    expect(wsMockState.options).toEqual([{ maxPayload: 1024 * 1024 }]);
  });

  it("rejects container receive endpoints that do not upgrade to WebSocket", async () => {
    wsMockState.behavior = "unexpected-response";
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await containerCheck("http://localhost:8080", 1000, "+14259798283");

    expect(result).toEqual({
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    });
  });

  it("rejects container receive endpoints that close before opening", async () => {
    wsMockState.behavior = "close";
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await containerCheck("http://localhost:8080", 1000, "+14259798283");

    expect(result).toEqual({
      ok: false,
      status: null,
      error: "Signal container receive WebSocket closed before open (1000: done)",
    });
  });
});

describe("streamContainerEvents", () => {
  it("redacts the account and bounds the opening handshake wait", async () => {
    const log = vi.fn();
    const onStreamOpen = vi.fn();
    wsMockState.behavior = "open";

    await streamContainerEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent: vi.fn(),
      onStreamOpen,
      logger: { log },
    });

    expect(onStreamOpen).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "[signal-ws] connecting to ws://localhost:8080/v1/receive/<redacted>",
    );
    expect(wsMockState.options).toEqual([{ maxPayload: 1024 * 1024, handshakeTimeout: 30_000 }]);
    expectMockLogNotContains(log, "+14259798283");
    expectMockLogNotContains(log, "%2B14259798283");
  });

  it.each([
    { timeoutMs: 1_000, expected: 1_000 },
    { timeoutMs: 60_000, expected: 60_000 },
    { timeoutMs: 0, expected: 30_000 },
    { timeoutMs: undefined, expected: 30_000 },
  ])(
    "preserves the stream opening budget for timeoutMs=$timeoutMs",
    async ({ timeoutMs, expected }) => {
      wsMockState.behavior = "open";
      await streamContainerEvents({
        baseUrl: "http://localhost:8080",
        account: "+15550001111",
        timeoutMs,
        onEvent: vi.fn(),
      });
      expect(wsMockState.options).toEqual([
        { maxPayload: 1024 * 1024, handshakeTimeout: expected },
      ]);
    },
  );

  it("drains accepted and socket-buffered receive events before resolving shutdown", async () => {
    wsMockState.behavior = "buffered-message";
    const abort = new AbortController();
    const removeEventListener = vi.spyOn(abort.signal, "removeEventListener");
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const timestamps: number[] = [];
    const stream = streamContainerEvents({
      baseUrl: "http://localhost:8080",
      abortSignal: abort.signal,
      timeoutMs: 0,
      onEvent: async (event) => {
        timestamps.push(event.envelope?.timestamp ?? 0);
        if (timestamps.length === 1) {
          markFirstStarted();
          await firstDelivery;
        }
      },
    });
    let settled = false;
    void stream.then(() => {
      settled = true;
    });

    await firstStarted;
    abort.abort();
    const settledBeforeDrain = await Promise.race([
      stream.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 10);
      }),
    ]);
    expect(settledBeforeDrain).toBe(false);
    expect(settled).toBe(false);

    releaseFirst();
    await expect(stream).resolves.toBeUndefined();
    expect(timestamps).toEqual([1, 2]);
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(wsMockState.terminations).toBe(0);
  });

  it("propagates a receive-handler failure that settles during shutdown", async () => {
    wsMockState.behavior = "buffered-message";
    const abort = new AbortController();
    const appendError = new Error("durable append failed during shutdown");
    let rejectDelivery!: (error: Error) => void;
    const delivery = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const stream = streamContainerEvents({
      baseUrl: "http://localhost:8080",
      abortSignal: abort.signal,
      onEvent: async () => {
        markFirstStarted();
        await delivery;
      },
    });

    await firstStarted;
    abort.abort();
    rejectDelivery(appendError);
    await expect(stream).rejects.toBe(appendError);
    expect(wsMockState.terminations).toBe(0);
  });

  it("bounds a stalled shutdown drain and records the accepted-message loss risk", async () => {
    vi.useFakeTimers();
    try {
      wsMockState.behavior = "buffered-message";
      const abort = new AbortController();
      const error = vi.fn();
      let settled = false;
      const stream = streamContainerEvents({
        baseUrl: "http://localhost:8080",
        abortSignal: abort.signal,
        timeoutMs: 0,
        onEvent: async () => await new Promise<void>(() => {}),
        logger: { error },
      }).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      abort.abort();
      await vi.advanceTimersByTimeAsync(1_499);
      expect(settled).toBe(false);
      expect(error).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(stream).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/receive events.*may be lost/i));
      expect(wsMockState.terminations).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes immediately when aborted before the opening handshake completes", async () => {
    wsMockState.behavior = "pending";
    const abort = new AbortController();
    const removeEventListener = vi.spyOn(abort.signal, "removeEventListener");
    const stream = streamContainerEvents({
      baseUrl: "http://localhost:8080",
      abortSignal: abort.signal,
      onEvent: vi.fn(),
    });

    abort.abort();
    await expect(stream).resolves.toBeUndefined();
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(wsMockState.terminations).toBe(0);
  });

  it("handles an already-aborted signal without leaving its connection pending", async () => {
    wsMockState.behavior = "pending";
    const abort = new AbortController();
    abort.abort();
    const result = await Promise.race([
      streamContainerEvents({
        baseUrl: "http://localhost:8080",
        abortSignal: abort.signal,
        onEvent: vi.fn(),
      }).then(() => "closed"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still pending"), 25);
      }),
    ]);

    expect(result).toBe("closed");
    expect(wsMockState.terminations).toBe(0);
  });

  it("propagates receive-handler failures to the stream", async () => {
    wsMockState.behavior = "message";
    const appendError = new Error("durable append failed");

    await expect(
      streamContainerEvents({
        baseUrl: "http://localhost:8080",
        account: "+14259798283",
        onEvent: async () => {
          throw appendError;
        },
      }),
    ).rejects.toBe(appendError);
  });
});
