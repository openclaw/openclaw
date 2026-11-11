import { describe, expect, it } from "vitest";
import type { JsonObject } from "./protocol.js";
import {
  buildCodexAppServerUsageSnapshot,
  formatCodexUsageLimitErrorMessage,
  resolveCodexUsageLimitResetAtMs,
  shouldRefreshCodexRateLimitsForUsageLimitMessage,
  summarizeCodexAccountRateLimits,
  summarizeCodexAccountUsage,
  summarizeCodexRateLimits,
} from "./rate-limits.js";

const nowMs = 1_700_000_000_000;
const nowSeconds = nowMs / 1000;
const window = (
  usedPercent: number,
  resetsAt: number | null,
  windowDurationMins: number | null = 300,
) => ({ usedPercent, windowDurationMins, resetsAt });
const bucket = (overrides: JsonObject = {}) => ({
  limitId: "codex",
  primary: null,
  secondary: null,
  ...overrides,
});
const namedBucket = (overrides: JsonObject = {}) => bucket({ limitName: "Codex", ...overrides });
const byLimitId = (codex: JsonObject, extras: JsonObject = {}) => ({
  rateLimitsByLimitId: { codex, ...extras },
});
const usageError = (params: Parameters<typeof formatCodexUsageLimitErrorMessage>[0]) =>
  formatCodexUsageLimitErrorMessage({
    codexErrorInfo: "usageLimitExceeded",
    ...params,
  });

describe("formatCodexUsageLimitErrorMessage", () => {
  it("does not infer a Codex usage limit from unrelated prose", () => {
    expect(formatCodexUsageLimitErrorMessage({ message: "Workspace usage limit" })).toBeUndefined();
    expect(shouldRefreshCodexRateLimitsForUsageLimitMessage("temporary usage limit warning")).toBe(
      false,
    );
  });

  it.each([
    {
      name: "preserves provider retry hints",
      options: {
        message: "You've hit your usage limit; try again at May 11th, 2026 9:00 AM.",
        rateLimits: { rateLimits: bucket({ primary: window(100, null) }) },
        nowMs: Date.UTC(2026, 4, 10, 23),
      },
      expected: /Codex says to try again at May 11th, 2026 9:00 AM/,
      rejected: /could not determine a reset time/,
    },
    {
      name: "does not borrow a sibling bucket's reset",
      options: {
        rateLimits: byLimitId(bucket({ primary: window(100, null) }), {
          other: { limitId: "other", primary: window(0, nowSeconds + 3600) },
        }),
        nowMs,
      },
      expected: /could not determine a reset time/,
      rejected: /Next reset|1 hour/,
    },
    {
      name: "reports authoritative unexhausted usage",
      options: {
        rateLimits: {
          rateLimits: bucket({ primary: window(0, null, null), rateLimitReachedType: null }),
        },
        rateLimitsAuthoritative: true,
      },
      expected: /current account usage does not report an exhausted limit/,
      rejected: /subscription usage limit|could not determine a reset time/,
    },
    {
      name: "does not infer availability from empty authoritative usage",
      options: {
        rateLimits: { rateLimits: bucket({ rateLimitReachedType: null }) },
        rateLimitsAuthoritative: true,
      },
      expected: /could not determine a reset time/,
      rejected: /current account usage does not report an exhausted limit|Retry the request/,
    },
  ])("$name", ({ options, expected, rejected }) => {
    const message = usageError(options);
    expect(message).toMatch(expected);
    expect(message).not.toMatch(rejected);
  });
});

describe("buildCodexAppServerUsageSnapshot", () => {
  it("includes additional quota groups and precise balances for account rows", () => {
    const payload = byLimitId(
      {
        limitId: "codex",
        planType: "pro",
        primary: window(10, 1_900_000_000),
        credits: { hasCredits: true, balance: "12.75" },
      },
      {
        extra: {
          limitId: "extra",
          limitName: "Extra quota",
          primary: window(75, 1_900_000_000),
        },
      },
    );
    const result = buildCodexAppServerUsageSnapshot(payload, { accountDetails: true });
    expect(result).toMatchObject({
      plan: "pro",
      billing: [{ type: "balance", amount: 12.75, unit: "credits" }],
      windows: [
        { label: "5h", usedPercent: 10, resetAt: 1_900_000_000_000 },
        { label: "5h", groupLabel: "Extra quota", usedPercent: 75 },
      ],
    });
    expect(buildCodexAppServerUsageSnapshot(payload).windows).toHaveLength(1);
  });

  it("uses weekly reset cadence and blocks until all exhausted windows reset", () => {
    const primaryReset = Math.ceil(nowMs / 1000) + 60 * 60;
    const weeklyReset = primaryReset + 7 * 24 * 60 * 60;
    const payload = byLimitId({
      limitId: "codex",
      planType: "plus",
      primary: window(100, primaryReset),
      secondary: window(100, weeklyReset, 24 * 60),
    });

    expect(buildCodexAppServerUsageSnapshot(payload).windows).toEqual([
      { label: "5h", usedPercent: 100, resetAt: primaryReset * 1000 },
      { label: "Week", usedPercent: 100, resetAt: weeklyReset * 1000 },
    ]);
    expect(summarizeCodexAccountUsage(payload, nowMs)?.usageLine).toBe(
      "weekly 100% \u00b7 short-term 100%",
    );
    expect(resolveCodexUsageLimitResetAtMs(payload, nowMs)).toBe(weeklyReset * 1000);
    expect(summarizeCodexRateLimits(payload, nowMs)).toContain("secondary 0% left");
  });

  it("formats unlimited Codex credits without currency wording", () => {
    const result = buildCodexAppServerUsageSnapshot({
      rateLimits: bucket({
        planType: "plus",
        credits: { hasCredits: true, unlimited: true, balance: null },
      }),
    });

    expect(result.plan).toBe("plus (Unlimited credits)");
  });
});

describe("summarizeCodexRateLimits", () => {
  it.each([
    [true, ["Codex is available."]],
    [false, ["Codex is paused by a usage limit.", "Your Codex usage limit is reached."]],
    [null, undefined],
  ] as const)(
    "preserves feature quota guidance separately from account permission %s",
    (ordinaryUsageAllowed, expectedAvailability) => {
      const resetsAt = nowMs / 1000 + 3600;
      const codex = bucket({ primary: window(10, resetsAt), rateLimitReachedType: null });
      const payload = {
        ordinaryUsageAllowed,
        ...byLimitId(codex, {
          extra: bucket({
            limitId: "extra",
            limitName: "Extra quota",
            primary: window(100, resetsAt),
            rateLimitReachedType: null,
          }),
        }),
      };

      expect(summarizeCodexAccountRateLimits(payload, nowMs)).toEqual(expectedAvailability);
      expect(resolveCodexUsageLimitResetAtMs(payload, nowMs)).toBe(resetsAt * 1000);
      expect(summarizeCodexRateLimits(payload, nowMs)).toContain(
        "Extra quota: primary 0% left ⏱1h",
      );
      const errorMessage = usageError({
        rateLimits: payload,
        rateLimitsAuthoritative: true,
        nowMs,
      });
      expect(errorMessage).toContain("Next reset in 1 hour");
      expect(errorMessage).not.toContain(
        "current account usage does not report an exhausted limit",
      );
    },
  );

  it("ignores empty named buckets instead of showing them as available limits", () => {
    const payload = byLimitId(namedBucket({ primary: window(5, nowSeconds + 3600) }), {
      premium: namedBucket({ limitId: "premium", limitName: "premium" }),
    });

    expect(summarizeCodexRateLimits(payload, nowMs)).toContain("Codex: primary 95% left ⏱1h");
    expect(summarizeCodexRateLimits(payload, nowMs)).not.toContain("premium");
    expect(summarizeCodexAccountUsage(payload, nowMs)?.usageLine).toBe("short-term 5%");
  });

  it("does not render a server-reported usage-limit block as available", () => {
    const payload = {
      rateLimits: namedBucket({
        credits: null,
        rateLimitReachedType: "rate_limit_reached",
      }),
    };

    expect(summarizeCodexRateLimits(payload, nowMs)).toBe("Codex: rate limit reached");
    expect(summarizeCodexAccountUsage(payload, nowMs)).toMatchObject({
      blocked: true,
      blockingReason: "Codex usage limit is reached",
    });
  });

  it("ignores metadata-only Codex buckets", () => {
    expect(summarizeCodexRateLimits(byLimitId(namedBucket({ planType: "plus" })))).toBeUndefined();
  });
});
