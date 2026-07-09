// Qqbot tests cover token plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "./token.js";

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
      timeoutMs: 30_000,
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

  it("passes timeoutMs to fetchWithSsrFGuard on every token fetch", async () => {
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":7200}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await new TokenManager().getAccessToken("app-id", "secret");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });
});
