import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { responseBodyViaPlaywright } from "./pw-tools-core.responses.js";

const mocks = vi.hoisted(() => ({ getPageForTargetId: vi.fn(), ensurePageState: vi.fn() }));
vi.mock("./pw-session.js", () => mocks);

const options = { cdpUrl: "http://127.0.0.1:18792", url: "**/api", timeoutMs: 500 };
const response = (body: () => Promise<Buffer>) => ({
  url: () => "https://example.com/api",
  status: () => 200,
  headers: () => ({ "content-type": "text/plain" }),
  body,
});

describe("response body operation lifecycle", () => {
  let page: EventEmitter;
  beforeEach(() => {
    vi.useFakeTimers();
    page = new EventEmitter();
    mocks.getPageForTargetId.mockResolvedValue(page);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  function expectCleanedUp() {
    expect(page.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  }
  const emitBody = (body: () => Promise<Buffer>) => page.emit("response", response(body));
  async function expectBodyInterrupted(
    interrupt: () => Promise<unknown> | void,
    delay = 0,
    signal?: AbortSignal,
  ) {
    const body = createDeferred<Buffer>();
    const result = responseBodyViaPlaywright({ ...options, signal });
    const rejected = expect(result).rejects.toThrow(
      signal ? "response request cancelled" : /timed out|timeout/i,
    );
    await vi.advanceTimersByTimeAsync(delay);
    emitBody(() => body.promise);
    try {
      await interrupt();
      await rejected;
      expectCleanedUp();
    } finally {
      body.resolve(Buffer.from("late response"));
    }
    return result.catch((error: unknown) => error);
  }

  it("keeps the total deadline after delayed response headers", async () => {
    await expectBodyInterrupted(() => vi.advanceTimersByTimeAsync(100), 400);
  });

  it("honors caller cancellation while waiting for the body", async () => {
    const controller = new AbortController();
    const reason = new Error("response request cancelled");
    expect(await expectBodyInterrupted(() => controller.abort(reason), 0, controller.signal)).toBe(
      reason,
    );
  });

  it("preserves the missing-response recovery hint and removes its listeners", async () => {
    const result = responseBodyViaPlaywright(options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(String(await result)).toContain("openclaw browser requests");
    expectCleanedUp();
  });

  it("selects only the first matching response and clears its deadline", async () => {
    const result = responseBodyViaPlaywright(options);
    const ignoredBody = vi.fn(async () => Buffer.from("ignored"));
    await vi.advanceTimersByTimeAsync(0);
    page.emit("response", { ...response(ignoredBody), url: () => "https://example.com/other" });
    emitBody(async () => Buffer.from("first response"));
    page.emit("response", response(ignoredBody));
    await expect(result).resolves.toMatchObject({ body: "first response", status: 200 });
    expect(ignoredBody).not.toHaveBeenCalled();
    expectCleanedUp();
  });

  it("settles page closure and absorbs a late body failure", async () => {
    const body = createDeferred<Buffer>();
    const result = responseBodyViaPlaywright(options);
    const rejected = expect(result).rejects.toThrow(
      "Page closed before response body was available.",
    );
    await vi.advanceTimersByTimeAsync(0);
    emitBody(() => body.promise);
    page.emit("close");
    await rejected;
    body.reject(new Error("late transport failure"));
    await vi.advanceTimersByTimeAsync(0);
    expectCleanedUp();
  });

  it("bounds response decoding without splitting a surrogate pair", async () => {
    const bytes = Buffer.from("prefix🙂B");
    const subarray = vi.spyOn(bytes, "subarray");
    const result = responseBodyViaPlaywright({ ...options, maxChars: 7 });
    await vi.advanceTimersByTimeAsync(0);
    emitBody(async () => bytes);
    await expect(result).resolves.toMatchObject({ body: "prefix", truncated: true });
    expect(subarray).toHaveBeenCalledWith(0, 28);
    expectCleanedUp();
  });
});
