import { describe, expect, it } from "vitest";
import { parseClawRouterPool } from "./pool.js";

const poolFixture = {
  version: "clawrouter.pool.v1",
  observedAt: "2026-10-11T12:00:00Z",
  policyId: "team",
  models: ["anthropic/sonnet", "anthropic/opus"],
  routing: {
    strategy: "included-first",
    includedQuotaReservePercent: 10,
    environmentFallback: false,
  },
  grants: [
    {
      key: "subscription/team",
      label: "Team account",
      provider: "anthropic",
      kind: "subscription",
      enabled: true,
      credentialStatus: "ready",
      plan: "Max",
      account: { email: "team@example.test", rateLimitTier: "max", subscriptionStatus: "active" },
      windows: [
        {
          id: "five-hour",
          window: "5h",
          models: null,
          remainingPercent: 75,
          resetAt: "2026-10-11T17:00:00Z",
        },
      ],
      extraUsage: {
        enabled: true,
        usedCredits: 1250,
        monthlyLimit: 10000,
        currency: "USD",
        spendLimitReached: false,
      },
      eligibility: { "anthropic/sonnet": "eligible", "anthropic/opus": "exhausted" },
      lastSelectedAt: "2026-10-11T11:59:00Z",
      selectedCount: 42,
    },
  ],
  usage: {
    days: 30,
    lanes: [
      {
        provider: "anthropic",
        grantLane: "subscription",
        requests: 42,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        costMicros: 1200000,
      },
    ],
    grants: [],
  },
};

describe("ClawRouter pool payload", () => {
  it("retains known account, quota, eligibility and traffic data without forwarding unknown fields", () => {
    const result = parseClawRouterPool({ ...poolFixture, apiKey: "not-forwarded" });
    expect(result).toEqual(poolFixture);
    expect(parseClawRouterPool({ version: "future" })).toBeUndefined();
    expect(parseClawRouterPool(null)).toBeUndefined();
  });

  it("omits invalid or missing fields and bounds upstream arrays", () => {
    const result = parseClawRouterPool({
      version: "clawrouter.pool.v1",
      models: [null, "good", "good", "x".repeat(257)],
      grants: Array.from({ length: 250 }, () => ({
        key: 42,
        account: "bad",
        enabled: "true",
        selectedCount: -1,
        windows: Array.from({ length: 30 }, () => ({
          remainingPercent: 101,
          resetAt: "bad",
          models: 4,
        })),
        eligibility: { good: "eligible", bad: "invented" },
      })),
      usage: { lanes: [{ requests: -1, costMicros: Infinity, inputTokens: "10" }] },
    });
    expect(result?.models).toEqual(["good"]);
    expect(result?.grants).toHaveLength(200);
    expect(result?.grants[0]?.windows).toHaveLength(20);
    expect(result?.grants[0]).toEqual({
      windows: Array.from({ length: 20 }, () => ({})),
      eligibility: { good: "eligible" },
    });
    expect(result?.usage).toEqual({ lanes: [{}], grants: [] });
  });
});
