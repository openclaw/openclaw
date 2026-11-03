import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_DATE_TIMESTAMP_MS, MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./rest-errors.js";
import { RestScheduler } from "./rest-scheduler.js";
import { createJsonResponse } from "./test-builders.test-support.js";

const messageRequest = {
  method: "POST",
  path: "/channels/c1/messages",
  priority: "standard",
} as const;
function recordLimit(
  scheduler: RestScheduler<unknown>,
  retry_after: number,
  headers?: HeadersInit,
) {
  const body = { retry_after, global: headers === undefined };
  scheduler.recordResponse(
    "POST /channels/c1/messages",
    messageRequest.path,
    createJsonResponse(body, { status: 429, headers }),
    body,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RestScheduler", () => {
  it("bounds the queue at 1000 requests and accepts work after draining", async () => {
    const release = createDeferred<void>();
    let active = 0;
    let peak = 0;
    const scheduler = new RestScheduler(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
    });
    const enqueue = (guild: string) =>
      scheduler.enqueue({ method: "GET", path: `/guilds/${guild}/roles`, priority: "background" });
    const requests = Array.from({ length: 1000 }, (_, index) => enqueue(`g${index}`));

    expect(() => enqueue("overflow")).toThrow("Discord request queue is full");

    release.resolve();
    await Promise.all(requests);
    await enqueue("after-drain");
    expect(peak).toBe(4);
  });

  it("limits a rate-limited request to three retries", async () => {
    const executor = vi.fn(async () => {
      const body = { message: "Rate limited", retry_after: 0.1, global: false };
      throw new RateLimitError(createJsonResponse(body, { status: 429 }), body);
    });
    const scheduler = new RestScheduler(executor);

    await expect(
      scheduler.enqueue({ method: "GET", path: "/channels/c1/messages", priority: "background" }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(executor).toHaveBeenCalledTimes(4);
  });

  it("ignores deadlines beyond the Date range", async () => {
    vi.useFakeTimers({ now: MAX_DATE_TIMESTAMP_MS });
    const executor = vi.fn(async () => "sent");
    const scheduler = new RestScheduler(executor);
    recordLimit(scheduler, 1);
    const request = scheduler.enqueue(messageRequest);
    expect(executor).toHaveBeenCalledTimes(1);
    await expect(request).resolves.toBe("sent");
  });

  it("caps oversized route rate-limit drain waits before scheduling", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const first = createDeferred<unknown>();
    const scheduler = new RestScheduler(() => first.promise);

    const active = scheduler.enqueue(messageRequest);
    recordLimit(scheduler, 0, {
      "X-RateLimit-Bucket": "bucket-1",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset-After": String((MAX_TIMER_TIMEOUT_MS + 1_000_000) / 1000),
    });
    const queued = scheduler.enqueue(messageRequest);
    first.resolve({ ok: true });
    await expect(active).resolves.toEqual({ ok: true });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    queued.catch(() => undefined);
  });
});
