import { describe, expect, it, vi } from "vitest";
import { fetchAnthropicUsage, resolveAnthropicUsageAuth } from "./usage.js";

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

function resolveAuth(overrides: Partial<Parameters<typeof resolveAnthropicUsageAuth>[0]> = {}) {
  return resolveAnthropicUsageAuth({
    config: {},
    env: {},
    provider: "anthropic",
    resolveApiKeyFromConfigAndStore: () => undefined,
    resolveOAuthToken: async () => null,
    ...overrides,
  });
}

function fetchUsage(overrides: Partial<Parameters<typeof fetchAnthropicUsage>[0]> = {}) {
  return fetchAnthropicUsage({
    config: {},
    env: {},
    provider: "anthropic",
    token: "oauth-token",
    timeoutMs: 5000,
    fetchFn: vi.fn(async () => Response.json({ five_hour: { utilization: 10 } })),
    ...overrides,
  });
}

function report(results: unknown[]) {
  return Response.json({
    data: [{ starting_at: "2026-07-06T00:00:00Z", ending_at: "2026-07-07T00:00:00Z", results }],
    has_more: false,
  });
}

describe("Anthropic provider usage", () => {
  it("aggregates provider-reported costs, cache tokens, models, and categories", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/organizations/cost_report")) {
        return report([{ amount: "1234", currency: "USD", description: "Claude API" }]);
      }
      return report([
        {
          uncached_input_tokens: 1_000,
          cache_creation: {
            ephemeral_1h_input_tokens: 100,
            ephemeral_5m_input_tokens: 50,
          },
          cache_read_input_tokens: 300,
          output_tokens: 250,
          model: "claude-opus-4-8",
        },
      ]);
    });

    const auth = await resolveAuth({
      env: { ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin-test" },
    });
    if (!("token" in auth) || !auth.token) {
      throw new Error("expected encoded Anthropic Admin API credentials");
    }
    const result = await fetchUsage({
      token: auth.token,
      fetchFn: fetchFn as typeof fetch,
    });

    const tokens = {
      inputTokens: 1_000,
      cacheWriteTokens: 150,
      cacheReadTokens: 300,
      outputTokens: 250,
      totalTokens: 1_700,
    };
    expect(result).toEqual({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [],
      plan: "Admin API",
      billing: [
        {
          type: "spend",
          label: "30-day API spend",
          amount: 12.34,
          unit: "USD",
          period: "30d",
        },
      ],
      costHistory: {
        unit: "USD",
        periodDays: 30,
        daily: [{ date: "2026-07-06", amount: 12.34, ...tokens }],
        models: [{ name: "claude-opus-4-8", ...tokens }],
        categories: [{ name: "Claude API", amount: 12.34 }],
      },
      summary: "1,700 tokens",
    });
    for (const [input, init] of fetchFn.mock.calls) {
      const url = requestUrl(input);
      expect(url.searchParams.get("bucket_width")).toBe("1d");
      expect((init as RequestInit).headers).toMatchObject({
        "anthropic-version": "2023-06-01",
        "x-api-key": "sk-ant-admin-test",
      });
    }
  });

  it.each([
    [`sk-ant-oat01-${"a".repeat(80)}`, `sk-ant-oat01-${"a".repeat(80)}`],
    ["sk-ant-admin-profile", 'openclaw:anthropic-admin:v1:{"token":"sk-ant-admin-profile"}'],
  ])("classifies stored usage credential %s", async (key, token) => {
    const result = await resolveAuth({
      resolveApiKeyCandidatesFromConfigAndStore: async () => [key],
    });
    expect(result).toEqual({ token });
  });

  it("prefers a stored Admin API key when normal API and OAuth credentials coexist", async () => {
    const result = await resolveAuth({
      resolveApiKeyFromConfigAndStore: () => "sk-ant-api03-inference",
      resolveApiKeyCandidatesFromConfigAndStore: async () => [
        "sk-ant-api03-inference",
        "sk-ant-admin-billing",
      ],
      resolveOAuthToken: async () => ({ token: "oauth-token" }),
    });
    expect(result).toEqual({
      token: 'openclaw:anthropic-admin:v1:{"token":"sk-ant-admin-billing"}',
    });
  });

  it("does not refresh the native Claude login for usage polling", async () => {
    const resolveOAuthToken = vi.fn(async () => null);
    const result = await resolveAuth({
      resolveOAuthToken,
    });
    expect(result).toEqual({ handled: true });
    expect(resolveOAuthToken).toHaveBeenCalledOnce();
    expect(resolveOAuthToken).toHaveBeenCalledWith({
      excludeProfileIds: ["anthropic:claude-cli"],
    });
  });

  it.each([
    [{ subscriptionType: "pro", rateLimitTier: "default_pro" }, "plan", "Pro"],
    [{ email: "profile@example.com" }, "accountEmail", "profile@example.com"],
    [{ fetchFn: vi.fn(async () => Response.json({})) }, "plan", undefined],
  ] as const)("attaches only applicable resolved metadata %j", async (options, field, expected) => {
    const snapshot = await fetchUsage(options);
    expect(snapshot[field]).toBe(expected);
  });
});
