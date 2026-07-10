// Qqbot tests cover token plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRetryDelayMs, TokenManager } from "./token.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

function mockGuardedTokenResponse(body: BodyInit, init?: ResponseInit): ReturnType<typeof vi.fn> {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(body, init),
    release,
  });
  return release;
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  release: ReturnType<typeof vi.fn>;
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  const release = vi.fn(async () => {});
  const response = new Response(stream, init);
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return {
    release,
    response,
    wasCanceled: () => canceled,
  };
}

describe("QQBot token manager", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps malformed access token JSON", async () => {
    const release = mockGuardedTokenResponse("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(new TokenManager().getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://bots.qq.com/app/getAppAccessToken",
      auditContext: "qqbot-token",
      capture: false,
      policy: {
        hostnameAllowlist: ["bots.qq.com"],
        allowRfc2544BenchmarkRange: true,
      },
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "QQBotPlugin/unknown",
        },
        body: JSON.stringify({ appId: "app-id", clientSecret: "secret" }),
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds access token responses without using response.text()", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const tracked = cancelTrackedResponse(`${"qqbot token unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));

    await expect(new TokenManager({ logger }).getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );

    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.release).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls.join("\n")).toContain("qqbot token unavailable");
    expect(logger.debug.mock.calls.join("\n")).not.toContain("tail");
  });

  it("passes the RFC2544 SSRF allowance to the token fetch (regression for #88984)", async () => {
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":7200}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(new TokenManager().getAccessToken("app-id", "secret")).resolves.toBe("token-1");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://bots.qq.com/app/getAppAccessToken",
        auditContext: "qqbot-token",
        policy: {
          hostnameAllowlist: ["bots.qq.com"],
          allowRfc2544BenchmarkRange: true,
        },
      }),
    );
  });

  it("does not cache access tokens forever when expires_in is unsafe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":1e309}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    const status = manager.getStatus("app-id");
    expect(status.status).toBe("valid");
    expect(status.expiresAt).toBe(Date.now() + 7200 * 1000);
  });

  it("does not extend explicit non-positive token lifetimes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":0}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    expect(manager.getStatus("app-id")).toEqual({
      status: "expired",
      expiresAt: Date.now(),
    });
  });

  describe("resolveRetryDelayMs", () => {
    it("applies exponential backoff with jitter on consecutive failures", () => {
      const p1 = {
        retryDelayMs: 1000,
        maxRetryDelayMs: 32000,
        circuitBreakerThreshold: 6,
        circuitBreakerCooldownMs: 300000,
        consecutiveRetries: 1,
      };
      for (let i = 0; i < 50; i++) {
        const r = resolveRetryDelayMs(p1);
        expect(r).toBeGreaterThanOrEqual(700); // 1000 * 0.7
        expect(r).toBeLessThanOrEqual(1300); // 1000 * 1.3
      }

      const p2 = { ...p1, consecutiveRetries: 2 };
      for (let i = 0; i < 50; i++) {
        const r = resolveRetryDelayMs(p2);
        expect(r).toBeGreaterThanOrEqual(1400); // 2000 * 0.7
        expect(r).toBeLessThanOrEqual(2600); // 2000 * 1.3
      }

      const p3 = { ...p1, consecutiveRetries: 3 };
      for (let i = 0; i < 50; i++) {
        const r = resolveRetryDelayMs(p3);
        expect(r).toBeGreaterThanOrEqual(2800); // 4000 * 0.7
        expect(r).toBeLessThanOrEqual(5200); // 4000 * 1.3
      }
    });

    it("caps backoff at maxRetryDelayMs", () => {
      const params = {
        retryDelayMs: 1000,
        maxRetryDelayMs: 5000,
        circuitBreakerThreshold: 10,
        circuitBreakerCooldownMs: 300000,
        consecutiveRetries: 8,
      };
      // 8 < 10 threshold, so 1000 * 2^(8-1) = 128000, capped at 5000
      for (let i = 0; i < 50; i++) {
        const r = resolveRetryDelayMs(params);
        expect(r).toBeGreaterThanOrEqual(3500); // 5000 * 0.7
        expect(r).toBeLessThanOrEqual(6500); // 5000 * 1.3
      }
    });

    it("trips circuit breaker after threshold", () => {
      const params = {
        retryDelayMs: 1000,
        maxRetryDelayMs: 32000,
        circuitBreakerThreshold: 6,
        circuitBreakerCooldownMs: 300000,
        consecutiveRetries: 7,
      };
      const result = resolveRetryDelayMs(params);
      expect(result).toBe(300000); // Exact cooldown, no jitter
    });
  });

  it("does not cache fetched tokens when the process clock is outside the Date range", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":7200}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager({ logger });
    try {
      await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(manager.getStatus("app-id")).toEqual({ status: "none", expiresAt: null });
    expect(logger.debug).toHaveBeenCalledWith(
      "[qqbot:token:app-id] Not cached: invalid process clock",
    );
  });
});
