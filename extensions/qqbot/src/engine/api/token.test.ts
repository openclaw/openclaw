import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "./token.js";

const ssrfMocks = vi.hoisted(() => {
  const release = vi.fn();
  const fetchWithSsrFGuard = vi.fn(
    async (params: { url: string; init?: RequestInit }) => ({
      response: await globalThis.fetch(params.url, params.init),
      release,
    }),
  );
  return { fetchWithSsrFGuard, release };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard,
}));

describe("QQBot token manager", () => {
  afterEach(() => {
    ssrfMocks.fetchWithSsrFGuard.mockClear();
    ssrfMocks.release.mockClear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("wraps malformed access token JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(new TokenManager().getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );
    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      url: "https://bots.qq.com/app/getAppAccessToken",
      auditContext: "qqbot-token-fetch",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "QQBotPlugin/unknown",
        },
        body: JSON.stringify({ appId: "app-id", clientSecret: "secret" }),
      },
    });
    expect(ssrfMocks.release).toHaveBeenCalledTimes(1);
  });

  it("does not cache access tokens forever when expires_in is unsafe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"access_token":"token-1","expires_in":1e309}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    const status = manager.getStatus("app-id");
    expect(status.status).toBe("valid");
    expect(status.expiresAt).toBe(Date.now() + 7200 * 1000);
  });

  it("does not extend explicit non-positive token lifetimes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    const fetch = vi.fn().mockResolvedValue(
      new Response('{"access_token":"token-1","expires_in":0}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    expect(manager.getStatus("app-id")).toEqual({
      status: "expired",
      expiresAt: Date.now(),
    });
  });
});
