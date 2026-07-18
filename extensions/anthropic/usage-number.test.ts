import { describe, expect, it } from "vitest";
import { fetchAnthropicUsage } from "./usage.js";

describe("Anthropic usage number parsing", () => {
  it.each([
    [12.5, 0.125],
    ["12.5", 0.125],
    ["0", 0],
  ])("accepts canonical decimal amounts %p", async (amount, expected) => {
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: adminToken("sk-ant-admin-test"),
      timeoutMs: 5_000,
      fetchFn: buildAdminUsageFetch(amount),
    });

    expect(snapshot.billing).toEqual([
      {
        type: "spend",
        label: "30-day API spend",
        amount: expected,
        unit: "USD",
        period: "30d",
      },
    ]);
    expect(snapshot.costHistory).toMatchObject({
      daily: [{ amount: expected }],
      categories: [{ name: "Claude API", amount: expected }],
    });
  });

  it.each(["1e1", "0x10", "12.5\n", " 12.5 "])(
    "rejects malformed decimal strings %p",
    async (amount) => {
      const snapshot = await fetchAnthropicUsage({
        config: {},
        env: {},
        provider: "anthropic",
        token: adminToken("sk-ant-admin-test"),
        timeoutMs: 5_000,
        fetchFn: buildAdminUsageFetch(amount),
      });

      expect(snapshot.billing).toEqual([
        {
          type: "spend",
          label: "30-day API spend",
          amount: 0,
          unit: "USD",
          period: "30d",
        },
      ]);
      expect(snapshot.costHistory).toMatchObject({
        daily: [{ amount: 0 }],
        categories: [{ name: "Claude API", amount: 0 }],
      });
    },
  );
});

function adminToken(token: string): string {
  return `openclaw:anthropic-admin:v1:${JSON.stringify({ token })}`;
}

function buildAdminUsageFetch(amount: unknown) {
  return async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.pathname.endsWith("/organizations/cost_report")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              starting_at: "2026-07-06T00:00:00Z",
              ending_at: "2026-07-07T00:00:00Z",
              results: [{ amount, currency: "USD", description: "Claude API" }],
            },
          ],
          has_more: false,
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        data: [
          {
            starting_at: "2026-07-06T00:00:00Z",
            ending_at: "2026-07-07T00:00:00Z",
            results: [
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
            ],
          },
        ],
        has_more: false,
      }),
      { status: 200 },
    );
  };
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}
