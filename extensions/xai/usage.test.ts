// Covers SuperGrok provider usage fetch parsing.
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { fetchXaiUsage } from "./usage.js";

describe("fetchXaiUsage", () => {
  it("fetches SuperGrok billing with Grok CLI headers", async () => {
    const reset = "2026-09-08T12:00:00Z";
    const mockFetch = createProviderUsageFetch(async (url, init) => {
      expect(url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer oauth-token",
        Accept: "application/json",
        "x-grok-client-mode": "cli",
        "x-grok-client-version": "1.0.4",
      });
      return makeResponse(200, {
        subscription_tier: "SuperGrok Heavy",
        config: {
          creditUsagePercent: 28.4,
          currentPeriod: {
            type: "SUBSCRIPTION_PERIOD_WEEKLY",
            end: reset,
          },
          prepaidBalance: { val: "1250" },
        },
      });
    });

    await expect(fetchXaiUsage("oauth-token", 5000, mockFetch)).resolves.toEqual({
      provider: "xai",
      displayName: "SuperGrok",
      windows: [
        {
          label: "Weekly",
          usedPercent: 28.4,
          resetAt: new Date(reset).getTime(),
        },
      ],
      billing: [
        {
          type: "balance",
          label: "Prepaid balance",
          amount: 12.5,
          unit: "USD",
        },
      ],
      plan: "SuperGrok Heavy",
    });
  });

  it("parses legacy monthly counters when the billing percent is absent", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        subscriptionTier: "Premium+",
        config: {
          used: { val: 2500 },
          monthly_limit: { val: 10000 },
          billing_period_end: "2026-09-30T00:00:00Z",
        },
      }),
    );

    const result = await fetchXaiUsage("oauth-token", 5000, mockFetch);

    expect(result.windows).toEqual([
      {
        label: "Monthly",
        usedPercent: 25,
        resetAt: new Date("2026-09-30T00:00:00Z").getTime(),
      },
    ]);
    expect(result.plan).toBe("Premium+");
  });

  it("keeps an explicit zero included-usage percent as a weekly window", async () => {
    const reset = "2026-09-28T12:01:29Z";
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        config: {
          creditUsagePercent: 0,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-21T12:01:29Z",
            end: reset,
          },
        },
      }),
    );

    const result = await fetchXaiUsage("oauth-token", 5000, mockFetch);

    expect(result).toMatchObject({
      displayName: "SuperGrok",
      plan: "SuperGrok",
      windows: [
        {
          label: "Weekly",
          usedPercent: 0,
          resetAt: new Date(reset).getTime(),
        },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it("reports omitted included usage for a valid weekly billing period without inventing a percent", async () => {
    const reset = "2026-09-28T12:01:29Z";
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-21T12:01:29Z",
            end: reset,
          },
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
          isUnifiedBillingUser: true,
          prepaidBalance: { val: 0 },
          billingPeriodStart: "2026-09-21T12:01:29Z",
          billingPeriodEnd: reset,
        },
      }),
    );

    const result = await fetchXaiUsage("oauth-token", 5000, mockFetch);

    expect(result).toEqual({
      provider: "xai",
      displayName: "SuperGrok",
      windows: [],
      billing: [
        {
          type: "balance",
          label: "Prepaid balance",
          amount: 0,
          unit: "USD",
        },
      ],
      plan: "SuperGrok",
      summary: "Included usage omitted",
    });
  });

  it("does not treat on-demand counters as included SuperGrok quota", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-21T12:01:29Z",
            end: "2026-09-28T12:01:29Z",
          },
          onDemandCap: { val: 10000 },
          onDemandUsed: { val: 2500 },
          prepaidBalance: { val: 0 },
        },
      }),
    );

    const result = await fetchXaiUsage("oauth-token", 5000, mockFetch);

    expect(result.windows).toEqual([]);
    expect(result.summary).toBe("Included usage omitted");
    expect(result.error).toBeUndefined();
    expect(result.plan).toBe("SuperGrok");
  });

  it("reports omitted included usage for a valid monthly billing period", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_MONTHLY",
            start: "2026-09-01T00:00:00Z",
            end: "2026-10-01T00:00:00Z",
          },
        },
      }),
    );

    const result = await fetchXaiUsage("oauth-token", 5000, mockFetch);

    expect(result.windows).toEqual([]);
    expect(result.summary).toBe("Included usage omitted");
    expect(result.error).toBeUndefined();
    expect(result.plan).toBe("SuperGrok");
  });

  it("returns token-expired errors for billing auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(401, { error: "expired" }));

    const result = await fetchXaiUsage("oauth-token", 5000, mockFetch);

    expect(result).toEqual({
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
      { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } },
      "No usage data",
    ],
    [
      "unusable included-usage percent",
      {
        config: {
          creditUsagePercent: -1,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-21T12:01:29Z",
            end: "2026-09-28T12:01:29Z",
          },
        },
      },
      "No usage data",
    ],
  ])("returns a stable error for %s", async (_name, payload, error) => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(200, payload));

    const result = await fetchXaiUsage("oauth-token", 5000, mockFetch);

    expect(result.error).toBe(error);
    expect(result.windows).toHaveLength(0);
  });
});
