// Discord tests cover rest scheduler plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_DATE_TIMESTAMP_MS, MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./rest-errors.js";
import { RestScheduler } from "./rest-scheduler.js";
import { createJsonResponse } from "./test-builders.test-support.js";

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
    expect(scheduler.queueSize).toBe(1000);
    expect(() =>
      scheduler.enqueue({ method: "GET", path: "/guilds/overflow/roles", priority: "background" }),
    ).toThrow("Discord request queue is full");

    release.resolve();
    await Promise.all(requests);
    expect(executor).toHaveBeenCalledTimes(1000);
    expect(scheduler.queueSize).toBe(0);
  });

  it("limits a rate-limited request to three retries", async () => {
    const executor = vi.fn(async () => {
      throw new RateLimitError(
        createJsonResponse(
          { message: "Rate limited", retry_after: 0.1, global: false },
          { status: 429 },
        ),
        { message: "Rate limited", retry_after: 0.1, global: false },
      );
    });
    const scheduler = new RestScheduler(executor);

    await expect(
      scheduler.enqueue({ method: "GET", path: "/channels/c1/messages", priority: "background" }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(executor).toHaveBeenCalledTimes(4);
    expect(scheduler.queueSize).toBe(0);
  });

  it("ignores 429 retry deadlines that exceed the Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(MAX_DATE_TIMESTAMP_MS);
    try {
      const scheduler = new RestScheduler(vi.fn());
      scheduler.recordResponse(
        "GET /channels/c1/messages",
        "/channels/c1/messages",
        createJsonResponse(
          { message: "Rate limited", retry_after: 1, global: true },
          { status: 429 },
        ),
        { message: "Rate limited", retry_after: 1, global: true },
      );

      expect(scheduler.getMetrics().globalRateLimitUntil).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps immediate 429 retry deadlines working", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    try {
      const scheduler = new RestScheduler(vi.fn());
      scheduler.recordResponse(
        "GET /channels/c1/messages",
        "/channels/c1/messages",
        createJsonResponse(
          { message: "Rate limited", retry_after: 0, global: true },
          { status: 429 },
        ),
        { message: "Rate limited", retry_after: 0, global: true },
      );

      expect(scheduler.getMetrics().globalRateLimitUntil).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it("rounds fractional millisecond 429 retry deadlines up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    try {
      const scheduler = new RestScheduler(vi.fn());
      scheduler.recordResponse(
        "GET /channels/c1/messages",
        "/channels/c1/messages",
        createJsonResponse(
          { message: "Rate limited", retry_after: 0.0004, global: true },
          { status: 429 },
        ),
        { message: "Rate limited", retry_after: 0.0004, global: true },
      );

      expect(scheduler.getMetrics().globalRateLimitUntil).toBe(Date.now() + 1);
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

      const active = scheduler.enqueue({
        method: "POST",
        path: "/channels/c1/messages",
        priority: "standard",
      });
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
      scheduler.recordResponse(
        "POST /channels/c1/messages",
        "/channels/c1/messages",
        createJsonResponse(
          { message: "Rate limited", retry_after: 0, global: false },
          {
            status: 429,
            headers: {
              "X-RateLimit-Bucket": "bucket-1",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset-After": String((MAX_TIMER_TIMEOUT_MS + 1_000_000) / 1000),
            },
          },
        ),
        { message: "Rate limited", retry_after: 0, global: false },
      );

      const queued = scheduler.enqueue({
        method: "POST",
        path: "/channels/c1/messages",
        priority: "standard",
      });
      first.resolve({ ok: true });
      await expect(active).resolves.toEqual({ ok: true });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      queued.catch(() => undefined);
    } finally {
      schedulerCleanup(timeoutSpy);
      vi.useRealTimers();
    }
  });
});

function schedulerCleanup(timeoutSpy: ReturnType<typeof vi.spyOn>): void {
  timeoutSpy.mockRestore();
}
