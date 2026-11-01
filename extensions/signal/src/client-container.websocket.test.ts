import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchModule from "openclaw/plugin-sdk/fetch-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containerCheck, streamContainerEvents } from "./client-container.js";

const state = vi.hoisted(() => ({
  receive: vi.fn<(socket: EventEmitter & { close(): void }) => void>(),
  buffered: false,
  urls: [] as string[],
  options: [] as Array<{ maxPayload?: number; handshakeTimeout?: number } | undefined>,
  terminations: 0,
}));
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
  WebSocket: class extends EventEmitter {
    private flushed = false;
    constructor(url: string | URL, options?: { maxPayload?: number; handshakeTimeout?: number }) {
      super();
      state.urls.push(String(url));
      state.options.push(options);
      setTimeout(() => state.receive(this), 0);
    }
    close() {
      if (state.buffered && !this.flushed) {
        this.flushed = true;
        // ws flushes buffered receiver frames before its final close event.
        this.emit("message", Buffer.from('{"envelope":{"timestamp":2}}'));
      }
      this.emit("close", 1000, Buffer.from("done"));
    }
    terminate() {
      state.terminations++;
    }
  },
}));
const baseUrl = "http://localhost:8080";
const account = "+14259798283";
function buffered(
  onEvent: Parameters<typeof streamContainerEvents>[0]["onEvent"],
  timeoutMs?: number,
) {
  state.buffered = true;
  state.receive.mockImplementation((socket) => {
    socket.emit("open");
    socket.emit("message", Buffer.from('{"envelope":{"timestamp":1}}'));
  });
  const abort = new AbortController();
  const log = vi.fn(),
    error = vi.fn(),
    opened = vi.fn(),
    finished = vi.fn();
  const stream = streamContainerEvents({
    baseUrl,
    account,
    timeoutMs,
    onEvent,
    onStreamOpen: opened,
    abortSignal: abort.signal,
    logger: { log, error },
  }).then(finished);
  return { abort, log, error, opened, finished, stream };
}
beforeEach(() => {
  vi.useFakeTimers();
  state.receive.mockReset();
  state.buffered = false;
  state.urls = [];
  state.options = [];
  state.terminations = 0;
  vi.spyOn(fetchModule, "resolveFetch").mockReturnValue(
    vi.fn<typeof fetch>().mockResolvedValue(new Response(null)),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("container receive health", () => {
  it.each([
    { behavior: "open", ok: true, status: 101, error: null },
    {
      behavior: "unexpected-response",
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    },
  ] as const)("reports $behavior", async ({ behavior, ...result }) => {
    state.receive.mockImplementation((socket) =>
      socket.emit(behavior, {}, { statusCode: 200, statusMessage: "OK" }),
    );
    const check = containerCheck(baseUrl, 1000, account);
    await vi.advanceTimersByTimeAsync(0);
    await expect(check).resolves.toEqual(result);
    expect(state.urls).toEqual(["ws://localhost:8080/v1/receive/%2B14259798283"]);
    expect(state.options).toEqual([{ maxPayload: 1024 * 1024 }]);
  });
});

describe("container receive lifecycle", () => {
  it("drains accepted and socket-buffered events before resolving shutdown", async () => {
    const delivery = createDeferred<void>();
    const timestamps: number[] = [];
    const { abort, log, opened, finished, stream } = buffered(async (event) => {
      timestamps.push(event.envelope?.timestamp ?? 0);
      if (timestamps.length === 1) {
        await delivery.promise;
      }
    }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(timestamps).toEqual([1]);
    abort.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(finished).not.toHaveBeenCalled();
    delivery.resolve();
    await stream;
    expect(timestamps).toEqual([1, 2]);
    expect(opened).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalled();
    const messages = log.mock.calls.flat().join("\n");
    expect(messages).not.toContain(account);
    expect(messages).not.toContain("%2B14259798283");
    expect(state.options).toEqual([{ maxPayload: 1024 * 1024, handshakeTimeout: 30_000 }]);
  });
  it("propagates a handler failure during shutdown", async () => {
    const delivery = createDeferred<void>();
    const error = new Error("durable append failed during shutdown");
    const { abort, stream } = buffered(() => delivery.promise);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    const rejected = expect(stream).rejects.toBe(error);
    delivery.reject(error);
    await rejected;
  });
  it("bounds a stalled drain and reports accepted-message loss risk", async () => {
    const { abort, error, finished, stream } = buffered(() => new Promise<void>(() => {}), 0);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(finished).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stream;
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/receive events.*may be lost/i));
    expect(state.terminations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes an already-aborted connection", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      streamContainerEvents({ baseUrl, abortSignal: abort.signal, onEvent: vi.fn() }),
    ).resolves.toBeUndefined();
  });
});
