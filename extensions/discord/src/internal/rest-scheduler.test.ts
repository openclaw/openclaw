import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_DATE_TIMESTAMP_MS, MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./rest-errors.js";
import { RestScheduler } from "./rest-scheduler.js";
import { createJsonResponse } from "./test-builders.test-support.js";

const messageRequest = {
  method: "POST",
  path: "/channels/c1/messages",
  priority: "standard",
} as const;
const rateLimit = (retry_after: number, global = false) => ({
  message: "Rate limited",
  retry_after,
  global,
});
function recordLimit(
  scheduler: RestScheduler<unknown>,
  body: ReturnType<typeof rateLimit>,
  headers?: HeadersInit,
) {
  scheduler.recordResponse(
    "POST /channels/c1/messages",
    messageRequest.path,
    createJsonResponse(body, { status: 429, headers }),
    body,
  );
}

describe("RestScheduler", () => {
  it("bounds the queue at 1000 requests and runs at most four workers", async () => {
    const release = createDeferred<void>();
    const executor = vi.fn(async () => await release.promise);
    const scheduler = new RestScheduler(executor);
    const requests = Array.from({ length: 1000 }, (_, index) =>
      scheduler.enqueue({
        method: "GET",
        path: `/guilds/g${index}/roles`,
        priority: "background",
      }),
    );

    expect(executor).toHaveBeenCalledTimes(4);
    expect(() =>
      scheduler.enqueue({ method: "GET", path: "/guilds/overflow/roles", priority: "background" }),
    ).toThrow("Discord request queue is full");

    release.resolve();
    await Promise.all(requests);
    expect(executor).toHaveBeenCalledTimes(1000);
    await scheduler.enqueue({
      method: "GET",
      path: "/guilds/after-drain/roles",
      priority: "background",
    });
    expect(executor).toHaveBeenCalledTimes(1001);
  });

  it("limits a rate-limited request to three retries", async () => {
    const executor = vi.fn(async () => {
      const body = rateLimit(0.1);
      throw new RateLimitError(createJsonResponse(body, { status: 429 }), body);
    });
    const scheduler = new RestScheduler(executor);

    await expect(
      scheduler.enqueue({ method: "GET", path: "/channels/c1/messages", priority: "background" }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(executor).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["ignores deadlines beyond the Date range", MAX_DATE_TIMESTAMP_MS, 1, 0],
    ["dispatches immediate deadlines", 1_000, 0, 0],
    ["rounds fractional milliseconds up", 1_000, 0.0004, 1],
  ] as const)("%s", async (_label, now, retryAfter, waitMs) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const executor = vi.fn(async () => "sent");
      const scheduler = new RestScheduler(executor);
      recordLimit(scheduler, rateLimit(retryAfter, true));
      const request = scheduler.enqueue(messageRequest);
      expect(executor).toHaveBeenCalledTimes(waitMs === 0 ? 1 : 0);
      if (waitMs > 0) {
        await vi.advanceTimersByTimeAsync(waitMs);
      }
      await expect(request).resolves.toBe("sent");
      expect(executor).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized route rate-limit drain waits before scheduling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const first = createDeferred<unknown>();
      const executor = vi.fn(async () => await first.promise);
      const scheduler = new RestScheduler(executor);

      const active = scheduler.enqueue(messageRequest);
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
      recordLimit(scheduler, rateLimit(0), {
        "X-RateLimit-Bucket": "bucket-1",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset-After": String((MAX_TIMER_TIMEOUT_MS + 1_000_000) / 1000),
      });
      const queued = scheduler.enqueue(messageRequest);
      first.resolve({ ok: true });
      await expect(active).resolves.toEqual({ ok: true });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      queued.catch(() => undefined);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
