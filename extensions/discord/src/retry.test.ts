import { RateLimitError } from "@buape/carbon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordRetryRunner, DISCORD_TRANSIENT_RE } from "./retry.js";

const ZERO_DELAY_RETRY = { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };

function createMockRateLimitError(retryAfter = 0.001): RateLimitError {
  const response = new Response(null, {
    status: 429,
    headers: {
      "X-RateLimit-Scope": "user",
      "X-RateLimit-Bucket": "test-bucket",
      "X-RateLimit-Limit": "5",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset-After": String(retryAfter),
    },
  });
  const request = new Request("https://discord.com/api/v10/test");
  return new RateLimitError(
    response,
    {
      retry_after: retryAfter,
      message: "rate limited",
      global: false,
    },
    request,
  );
}

describe("createDiscordRetryRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries on RateLimitError", async () => {
    vi.useFakeTimers();
    const runner = createDiscordRetryRunner({ retry: { ...ZERO_DELAY_RETRY, attempts: 2 } });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(createMockRateLimitError())
      .mockResolvedValueOnce("ok");

    const promise = runner(fn, "test");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "502 Bad Gateway", error: new Error("502 Bad Gateway") },
    { name: "503 Service Unavailable", error: new Error("503 Service Unavailable") },
    { name: "fetch failed", error: new Error("fetch failed") },
    {
      name: "ECONNRESET",
      error: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    },
    { name: "connection timeout", error: new Error("connection timeout") },
    { name: "ETIMEDOUT", error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) },
    { name: "ENOTFOUND", error: Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }) },
    { name: "socket hang up", error: new Error("socket hang up") },
    {
      name: "service temporarily unavailable",
      error: new Error("service temporarily unavailable"),
    },
  ])("retries transient error: $name", async ({ error }) => {
    vi.useFakeTimers();
    const runner = createDiscordRetryRunner({ retry: { ...ZERO_DELAY_RETRY, attempts: 2 } });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("ok");

    const promise = runner(fn, "test");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each(["Invalid Form Body", "Unknown Channel", "Missing Permissions"])(
    "does not retry permanent error: %s",
    async (message) => {
      const runner = createDiscordRetryRunner({ retry: { ...ZERO_DELAY_RETRY, attempts: 3 } });
      const fn = vi.fn().mockImplementation(() => Promise.reject(new Error(message)));

      await expect(runner(fn, "test")).rejects.toThrow(message);
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it("exhausts all attempts on repeated transient errors", async () => {
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });
    const fn = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error("503 Service Unavailable")));

    await expect(runner(fn, "test")).rejects.toThrow("503 Service Unavailable");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("DISCORD_TRANSIENT_RE", () => {
  it.each([
    "502",
    "503",
    "timeout",
    "timed out",
    "connect",
    "reset",
    "closed",
    "unavailable",
    "temporarily",
    "fetch failed",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "socket hang up",
  ])("matches transient pattern: %s", (pattern) => {
    expect(DISCORD_TRANSIENT_RE.test(pattern)).toBe(true);
  });

  it.each([
    "Invalid Form Body",
    "Unknown Channel",
    "Missing Permissions",
    "bad request",
    "forbidden",
  ])("does not match permanent error: %s", (pattern) => {
    expect(DISCORD_TRANSIENT_RE.test(pattern)).toBe(false);
  });
});
