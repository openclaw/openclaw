import { describe, expect, it, vi } from "vitest";
import { refreshAnthropicTokens } from "./anthropic-oauth.js";

function mockFetch(response: { ok: boolean; status: number; body: unknown }): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
  }) as unknown as typeof fetch;
}

describe("refreshAnthropicTokens", () => {
  const baseCred = {
    type: "oauth" as const,
    provider: "anthropic",
    access: "old-access",
    refresh: "old-refresh",
    expires: 0,
  };

  it("returns refreshed credentials on success", async () => {
    const now = 1_700_000_000_000;
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      },
    });

    const result = await refreshAnthropicTokens({
      credential: baseCred,
      fetchFn,
      now,
    });

    expect(result.access).toBe("new-access");
    expect(result.refresh).toBe("new-refresh");
    expect(result.expires).toBeGreaterThan(now);
    expect(result.provider).toBe("anthropic");
  });

  it("keeps old refresh token when new one is not provided", async () => {
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: {
        access_token: "new-access",
        expires_in: 3600,
      },
    });

    const result = await refreshAnthropicTokens({
      credential: baseCred,
      fetchFn,
    });

    expect(result.access).toBe("new-access");
    expect(result.refresh).toBe("old-refresh");
  });

  it("throws when refresh token is missing", async () => {
    await expect(
      refreshAnthropicTokens({
        credential: { ...baseCred, refresh: "" },
        fetchFn: mockFetch({ ok: true, status: 200, body: {} }),
      }),
    ).rejects.toThrow("missing refresh token");
  });

  it("throws with error detail on non-OK response", async () => {
    const fetchFn = mockFetch({
      ok: false,
      status: 401,
      body: { error_description: "invalid_grant" },
    });

    await expect(refreshAnthropicTokens({ credential: baseCred, fetchFn })).rejects.toThrow(
      "invalid_grant",
    );
  });

  it("throws with status code when error response is not JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    }) as unknown as typeof fetch;

    await expect(refreshAnthropicTokens({ credential: baseCred, fetchFn })).rejects.toThrow(
      "status 500",
    );
  });

  it("throws when no access_token in response", async () => {
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: { refresh_token: "new-refresh", expires_in: 3600 },
    });

    await expect(refreshAnthropicTokens({ credential: baseCred, fetchFn })).rejects.toThrow(
      "no access_token",
    );
  });

  it("applies 5-minute buffer to expiry and enforces 30s minimum", async () => {
    const now = 1_700_000_000_000;

    // Short expiry (10 seconds) — buffer would push it negative, so minimum 30s applies
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: { access_token: "a", expires_in: 10 },
    });

    const result = await refreshAnthropicTokens({
      credential: baseCred,
      fetchFn,
      now,
    });

    // Should be at least now + 30s (minimum floor)
    expect(result.expires).toBe(now + 30_000);
  });

  it("applies 5-minute buffer correctly for normal expiry", async () => {
    const now = 1_700_000_000_000;
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: { access_token: "a", expires_in: 3600 },
    });

    const result = await refreshAnthropicTokens({
      credential: baseCred,
      fetchFn,
      now,
    });

    // 3600s = 3_600_000ms, minus 5min buffer (300_000ms) = 3_300_000ms
    expect(result.expires).toBe(now + 3_300_000);
  });

  it("uses custom clientId from credential", async () => {
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: { access_token: "a", expires_in: 3600 },
    });

    const result = await refreshAnthropicTokens({
      credential: { ...baseCred, clientId: "custom-id" },
      fetchFn,
    });

    expect(result.clientId).toBe("custom-id");
    const callBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(callBody.client_id).toBe("custom-id");
  });

  it("preserves email from original credential", async () => {
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      body: { access_token: "a", expires_in: 3600 },
    });

    const result = await refreshAnthropicTokens({
      credential: { ...baseCred, email: "user@test.com" } as Parameters<
        typeof refreshAnthropicTokens
      >[0]["credential"],
      fetchFn,
    });

    expect((result as Record<string, unknown>).email).toBe("user@test.com");
  });
});
