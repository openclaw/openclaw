import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

let page: EventEmitter;
beforeEach(() => {
  vi.useFakeTimers();
  page = new EventEmitter();
  mocks.getPageForTargetId.mockResolvedValue(page);
});
afterEach(() => {
  try {
    expect(page.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.clearAllMocks();
  }
});
const emitBody = (body: () => Promise<Buffer>) => page.emit("response", response(body));
it.each([false, true])("cleans up an interrupted body (cancel: %s)", async (cancel) => {
  const controller = new AbortController();
  const reason = new Error("response request cancelled");
  const body = createDeferred<Buffer>();
  const result = responseBodyViaPlaywright({ ...options, signal: controller.signal });
  const rejected = cancel
    ? expect(result).rejects.toBe(reason)
    : expect(result).rejects.toThrow(/timed out|timeout/i);
  await vi.advanceTimersByTimeAsync(cancel ? 0 : 400);
  emitBody(() => body.promise);
  try {
    if (cancel) {
      controller.abort(reason);
    } else {
      await vi.advanceTimersByTimeAsync(100);
    }
    await rejected;
  } finally {
    body.resolve(Buffer.from("late response"));
  }
});

it("preserves the missing-response recovery hint and removes its listeners", async () => {
  const result = responseBodyViaPlaywright(options).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(500);
  expect(String(await result)).toContain("openclaw browser requests");
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
});

it("bounds response decoding without splitting a surrogate pair", async () => {
  const bytes = Buffer.from("prefix🙂B");
  const subarray = vi.spyOn(bytes, "subarray");
  const result = responseBodyViaPlaywright({ ...options, maxChars: 7 });
  await vi.advanceTimersByTimeAsync(0);
  emitBody(async () => bytes);
  await expect(result).resolves.toMatchObject({ body: "prefix", truncated: true });
  expect(subarray).toHaveBeenCalledWith(0, 28);
});
