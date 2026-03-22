import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test/helpers/extensions/fetch-mock.js";
import { refreshQwenPortalCredentials } from "./refresh.js";

function expiredCredentials() {
  return {
    type: "oauth" as const,
    provider: "qwen-portal",
    access: "expired-access",
    refresh: "refresh-token",
    expires: Date.now() - 60_000,
  };
}

describe("refreshQwenPortalCredentials", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const runRefresh = async () => await refreshQwenPortalCredentials(expiredCredentials());

  it("refreshes oauth credentials and preserves existing refresh token when absent", async () => {
    globalThis.fetch = withFetchPreconnect(
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "new-access",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await runRefresh();

    expect(result.access).toBe("new-access");
    expect(result.refresh).toBe("refresh-token");
    expect(result.expires).toBeGreaterThan(Date.now());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://chat.qwen.ai/api/v1/oauth2/token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
      }),
    );
  });

  it("replaces the refresh token when the server rotates it", async () => {
    globalThis.fetch = withFetchPreconnect(
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "rotated-refresh",
            expires_in: 1200,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await runRefresh();

    expect(result.refresh).toBe("rotated-refresh");
  });

  it("rejects invalid expires_in payloads", async () => {
    globalThis.fetch = withFetchPreconnect(
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "new-access",
            expires_in: 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    await expect(runRefresh()).rejects.toThrow(
      "Qwen OAuth refresh response missing or invalid expires_in",
    );
  });

  it("turns 400 responses into a re-authenticate hint", async () => {
    globalThis.fetch = withFetchPreconnect(
      vi.fn(async () => new Response("bad refresh", { status: 400 })),
    );

    await expect(runRefresh()).rejects.toThrow("Qwen OAuth refresh token expired or invalid");
  });

  it("requires a refresh token", async () => {
    await expect(
      refreshQwenPortalCredentials({
        type: "oauth",
        provider: "qwen-portal",
        access: "expired-access",
        refresh: "",
        expires: Date.now() - 60_000,
      }),
    ).rejects.toThrow("Qwen OAuth refresh token missing");
  });

  it("rejects missing access tokens", async () => {
    globalThis.fetch = withFetchPreconnect(
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    await expect(runRefresh()).rejects.toThrow("Qwen OAuth refresh response missing access token");
  });

  it("surfaces non-400 refresh failures", async () => {
    globalThis.fetch = withFetchPreconnect(
      vi.fn(async () => new Response("gateway down", { status: 502 })),
    );

    await expect(runRefresh()).rejects.toThrow("Qwen OAuth refresh failed: gateway down");
  });
});
