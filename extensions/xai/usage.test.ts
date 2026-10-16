import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { fetchXaiUsage } from "./usage.js";

const weekly = {
  type: "USAGE_PERIOD_TYPE_WEEKLY",
  start: "2026-09-21T12:01:29Z",
  end: "2026-09-28T12:01:29Z",
};
const omitted = { windows: [], summary: "Included usage omitted" };

describe("fetchXaiUsage", () => {
  it.each([
    {
      name: "explicit zero weekly usage",
      payload: {
        subscription_tier: "SuperGrok Heavy",
        config: {
          creditUsagePercent: 0,
          currentPeriod: weekly,
          prepaidBalance: { val: "1250" },
        },
      },
      expected: {
        windows: [{ label: "Weekly", usedPercent: 0, resetAt: Date.parse(weekly.end) }],
      },
      plan: "SuperGrok Heavy",
      balance: 12.5,
    },
    {
      name: "legacy monthly counters",
      payload: {
        subscriptionTier: "Premium+",
        config: {
          used: { val: 2500 },
          monthly_limit: { val: 10000 },
          billing_period_end: "2026-09-30T00:00:00Z",
        },
      },
      expected: {
        windows: [
          { label: "Monthly", usedPercent: 25, resetAt: Date.parse("2026-09-30T00:00:00Z") },
        ],
      },
      plan: "Premium+",
      balance: 0,
    },
    {
      name: "omitted weekly usage despite on-demand counters",
      payload: {
        config: {
          currentPeriod: weekly,
          onDemandCap: { val: 10000 },
          onDemandUsed: { val: 2500 },
          isUnifiedBillingUser: true,
          prepaidBalance: { val: 0 },
          billingPeriodStart: weekly.start,
          billingPeriodEnd: weekly.end,
        },
      },
      expected: omitted,
      plan: "SuperGrok",
      balance: 0,
    },
    {
      name: "omitted monthly usage",
      payload: { config: { currentPeriod: { ...weekly, type: "USAGE_PERIOD_TYPE_MONTHLY" } } },
      expected: omitted,
      plan: "SuperGrok",
      balance: 0,
    },
  ])(
    "fetches billing with CLI headers and preserves $name",
    async ({ payload, expected, plan, balance }) => {
      const mockFetch = createProviderUsageFetch(async (url, init) => {
        expect(url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer oauth-token",
          Accept: "application/json",
          "x-grok-client-mode": "cli",
          "x-grok-client-version": "1.0.4",
        });
        return makeResponse(200, payload);
      });
      await expect(fetchXaiUsage("oauth-token", 5000, mockFetch)).resolves.toEqual({
        provider: "xai",
        displayName: "SuperGrok",
        billing: [{ type: "balance", label: "Prepaid balance", amount: balance, unit: "USD" }],
        plan,
        ...expected,
      });
    },
  );

  it("returns token-expired errors for billing auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(401, { error: "expired" }));
    await expect(fetchXaiUsage("oauth-token", 5000, mockFetch)).resolves.toEqual({
      provider: "xai",
      displayName: "xAI",
      windows: [],
      error: "Token expired",
    });
  });

  it.each([
    ["malformed JSON", "{not-json", "Malformed billing response"],
    ["missing config", {}, "Malformed billing response"],
    ["missing usage fields", { config: { prepaidBalance: { val: "100" } } }, "No usage data"],
    [
      "weekly period without bounds",
      { config: { currentPeriod: { type: weekly.type } } },
      "No usage data",
    ],
    [
      "unusable included-usage percent",
      { config: { creditUsagePercent: -1, currentPeriod: weekly } },
      "No usage data",
    ],
  ])("returns a stable error for %s", async (_name, payload, error) => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(200, payload));
    const result = await fetchXaiUsage("oauth-token", 5000, mockFetch);
    expect(result.error).toBe(error);
    expect(result.windows).toHaveLength(0);
  });
});
