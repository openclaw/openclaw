import { describe, expect, it } from "vitest";
import { formatCodexStatus } from "../command-formatters.js";
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
const emptyBucket = (overrides: JsonObject = {}) =>
  namedBucket({
    credits: null,
    planType: "pro",
    rateLimitReachedType: null,
    ...overrides,
  });
const byLimitId = (codex: JsonObject, extras: JsonObject = {}) => ({
  rateLimitsByLimitId: { codex, ...extras },
});
const usageError = (params: Parameters<typeof formatCodexUsageLimitErrorMessage>[0]) =>
  formatCodexUsageLimitErrorMessage({
    message: "You've reached your usage limit.",
    codexErrorInfo: "usageLimitExceeded",
    ...params,
  });

describe("formatCodexUsageLimitErrorMessage", () => {
  it("does not infer a Codex usage limit from unrelated prose", () => {
    expect(
      formatCodexUsageLimitErrorMessage({
        message: "The workspace usage limit setting could not be loaded.",
      }),
    ).toBeUndefined();
    expect(shouldRefreshCodexRateLimitsForUsageLimitMessage("temporary usage limit warning")).toBe(
      false,
    );
  });

  it("preserves Codex retry hints when structured reset windows are absent", () => {
    const message = usageError({
      message: "You've hit your usage limit; try again at May 11th, 2026 9:00 AM.",
      rateLimits: { rateLimits: bucket({ primary: window(100, null) }) },
      nowMs: Date.UTC(2026, 4, 10, 23, 0, 0),
    });

    expect(message).toContain("You've reached your Codex subscription usage limit.");
    expect(message).toContain("Codex says to try again at May 11th, 2026 9:00 AM.");
    expect(message).toContain("Wait until the retry time");
    expect(message).not.toContain("Codex did not return a reset time");
  });

  it("does not use sibling bucket resets when the blocked Codex bucket omits a reset", () => {
    const message = usageError({
      rateLimits: byLimitId(namedBucket({ primary: window(100, null) }), {
        "gpt-5.3-codex-spark": bucket({
          limitId: "gpt-5.3-codex-spark",
          limitName: "GPT 5.3 Codex Spark",
          primary: window(0, nowSeconds + 3600),
        }),
      }),
      nowMs,
    });

    expect(message).toContain("OpenClaw could not determine a reset time from Codex.");
    expect(message).toContain("Wait until Codex becomes available");
    expect(message).not.toContain("Next reset");
    expect(message).not.toContain("1 hour");
  });

  it("does not report exhaustion when an authoritative snapshot has no active limit", () => {
    const message = usageError({
      rateLimits: {
        rateLimits: bucket({ primary: window(0, null, null), rateLimitReachedType: null }),
      },
      rateLimitsAuthoritative: true,
    });

    expect(message).toContain("current account usage does not report an exhausted limit");
    expect(message).not.toContain("subscription usage limit");
    expect(message).not.toContain("could not determine a reset time");
  });

  it("does not infer availability from an empty authoritative snapshot", () => {
    const message = usageError({
      rateLimits: { rateLimits: bucket({ rateLimitReachedType: null }) },
      rateLimitsAuthoritative: true,
    });

    expect(message).not.toContain("current account usage does not report an exhausted limit");
    expect(message).not.toContain("Retry the request");
    expect(message).toContain("OpenClaw could not determine a reset time from Codex.");
  });
});

describe("buildCodexAppServerUsageSnapshot", () => {
  it("discloses only the distinct reserve route (gpt-reserve)", () => {
    const value = byLimitId(
      { limitId: "codex", primary: { usedPercent: 100 } },
      {
        alias: {
          limitId: "base_model_inference",
          limitName: "gpt-reserve",
          normalModelSlug: "gpt-5.6-luna",
          secondary: { usedPercent: 0 },
        },
      },
    );
    const snapshot = buildCodexAppServerUsageSnapshot(value);
    const status = summarizeCodexRateLimits(value);
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.summary).toContain("Ordinary Luna does not use this reserve");
    expect(status).toContain("Luna Reserve (separate route)");
    expect(status).toContain("does not establish eligibility or per-request billing");
    const command = formatCodexStatus({
      models: { ok: true, value: { models: [] } },
      account: { ok: true, value: { requiresOpenaiAuth: false } },
      limits: { ok: true, value },
      mcps: { ok: true, value: { data: [] } },
      skills: { ok: true, value: { data: [] } },
    });
    expect(command).toContain(". Luna Reserve is a separate");
  });

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

  it("uses reset cadence when Codex reports a 24h weekly secondary window", () => {
    const primaryReset = Math.ceil(nowMs / 1000) + 60 * 60;
    const weeklyReset = primaryReset + 7 * 24 * 60 * 60;
    const payload = byLimitId({
      limitId: "codex",
      planType: "plus",
      primary: window(9, primaryReset),
      secondary: window(30, weeklyReset, 24 * 60),
    });

    expect(buildCodexAppServerUsageSnapshot(payload).windows).toEqual([
      { label: "5h", usedPercent: 9, resetAt: primaryReset * 1000 },
      { label: "Week", usedPercent: 30, resetAt: weeklyReset * 1000 },
    ]);
    expect(summarizeCodexAccountUsage(payload, nowMs)?.usageLine).toBe(
      "weekly 30% \u00b7 short-term 9%",
    );
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

it("keeps subscriptions blocked until all exhausted windows reset", () => {
  const shortTermReset = Math.ceil(nowMs / 1000) + 60 * 60;
  const weeklyReset = Math.ceil(nowMs / 1000) + 24 * 60 * 60;
  const payload = byLimitId({
    limitId: "codex",
    primary: window(100, shortTermReset),
    secondary: window(100, weeklyReset, 10_080),
  });

  expect(resolveCodexUsageLimitResetAtMs(payload, nowMs)).toBe(weeklyReset * 1000);
  expect(summarizeCodexAccountUsage(payload, nowMs)?.blockedResetRelative).toBe("in 1 day");
});
describe("summarizeCodexRateLimits", () => {
  it.each([true, false, null])(
    "preserves feature quota guidance separately from account permission %s",
    (ordinaryUsageAllowed) => {
      const resetsAt = nowMs / 1000 + 3600;
      const codex = bucket({ primary: window(10, resetsAt), rateLimitReachedType: null });
      const payload = {
        ordinaryUsageAllowed,
        rateLimits: codex,
        ...byLimitId(codex, {
          extra: bucket({
            limitId: "extra",
            limitName: "Extra quota",
            primary: window(100, resetsAt),
            rateLimitReachedType: null,
          }),
        }),
      };

      const accountAvailability = summarizeCodexAccountRateLimits(payload, nowMs);
      if (ordinaryUsageAllowed === null) {
        expect(accountAvailability).toBeUndefined();
      } else if (!ordinaryUsageAllowed) {
        expect(accountAvailability?.[0]).toBe("Codex is paused by a usage limit.");
      } else {
        expect(accountAvailability).toEqual(["Codex is available."]);
      }
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

  it("formats status limits like provider usage summaries", () => {
    const rateLimits = namedBucket({
      primary: window(26, nowSeconds + 3 * 60 * 60),
      secondary: window(4, nowSeconds + 7 * 24 * 60 * 60, 7 * 24 * 60),
    });
    expect(summarizeCodexRateLimits({ rateLimits }, nowMs)).toBe(
      "Codex: primary 74% left ⏱3h · secondary 96% left ⏱7d",
    );
  });

  it("ignores empty named buckets instead of showing them as available limits", () => {
    const payload = byLimitId(emptyBucket({ primary: window(5, Math.ceil(nowSeconds) + 3600) }), {
      premium: emptyBucket({ limitId: "premium", limitName: "premium" }),
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
    expect(summarizeCodexRateLimits(byLimitId(emptyBucket({ planType: "plus" })))).toBeUndefined();
  });
});
