import { describe, expect, it } from "vitest";
import { projectCodexAppServerError } from "./error-projection.js";
import type { RateLimitSnapshot } from "./protocol-generated/typescript/v2/RateLimitSnapshot.js";

function snapshot(partial: Partial<RateLimitSnapshot>): RateLimitSnapshot {
  return {
    limitId: null,
    limitName: null,
    primary: null,
    secondary: null,
    credits: null,
    planType: null,
    rateLimitReachedType: null,
    ...partial,
  };
}

describe("projectCodexAppServerError", () => {
  it("formats usageLimitExceeded with plan label and reset window", () => {
    const result = projectCodexAppServerError({
      message: "ChatGPT rate limit reached",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: undefined,
      rateLimits: snapshot({
        planType: "plus",
        primary: { usedPercent: 100, windowDurationMins: 86, resetsAt: null },
      }),
    });
    expect(result).toBeDefined();
    // Keywords required by RATE_LIMIT_SPECIFIC_HINT_RE
    // (`/\bmin(ute)?s?\b|\bplan\b|\bquota\b/`).
    expect(result).toMatch(/usage limit/i);
    expect(result).toMatch(/plan/i);
    expect(result).toMatch(/86 minutes/);
    expect(result).toMatch(/ChatGPT Plus/);
  });

  it("prefers `resetsAt` when available", () => {
    const nowSeconds = 1_700_000_000;
    const result = projectCodexAppServerError({
      message: "rate limited",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: undefined,
      nowSeconds,
      rateLimits: snapshot({
        planType: "prolite",
        primary: {
          usedPercent: 100,
          windowDurationMins: null,
          resetsAt: nowSeconds + 90 * 60, // 90 minutes
        },
      }),
    });
    expect(result).toMatch(/90 minutes/);
    expect(result).toMatch(/ChatGPT Plus \(lite\)/);
  });

  it("uses larger time units when reset is hours away", () => {
    const nowSeconds = 1_700_000_000;
    const result = projectCodexAppServerError({
      message: "rate limited",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: undefined,
      nowSeconds,
      rateLimits: snapshot({
        planType: "pro",
        primary: {
          usedPercent: 100,
          windowDurationMins: null,
          resetsAt: nowSeconds + 4 * 60 * 60, // 4 hours
        },
      }),
    });
    expect(result).toMatch(/~4 hours/);
  });

  it("falls back to a generic plan reminder when no snapshot is available", () => {
    const result = projectCodexAppServerError({
      message: "ChatGPT usage limit reached",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: undefined,
      rateLimits: undefined,
    });
    // Required keywords for the existing rate-limit classifier to fire.
    expect(result).toMatch(/usage limit/i);
    expect(result).toMatch(/plan/i);
  });

  it("preserves a distinct upstream message when no retry window is known", () => {
    const result = projectCodexAppServerError({
      message: "Free trial credits exhausted",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: undefined,
      rateLimits: undefined,
    });
    expect(result).toContain("Free trial credits exhausted");
    expect(result).toMatch(/usage limit/i);
  });

  it("appends additionalDetails when distinct from the headline", () => {
    const result = projectCodexAppServerError({
      message: "rate limited",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: "Upgrade to ChatGPT Pro to continue.",
      rateLimits: snapshot({
        planType: "plus",
        primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: null },
      }),
    });
    expect(result).toContain("Upgrade to ChatGPT Pro to continue.");
    expect(result).toMatch(/60 minutes/);
  });

  it("formats serverOverloaded with the overloaded keyword", () => {
    const result = projectCodexAppServerError({
      message: "service overloaded",
      codexErrorInfo: "serverOverloaded",
      additionalDetails: undefined,
      rateLimits: undefined,
    });
    expect(result).toMatch(/overloaded/i);
  });

  it("returns undefined when no codexErrorInfo and no extra details", () => {
    expect(
      projectCodexAppServerError({
        message: "stream failed",
        codexErrorInfo: null,
        additionalDetails: undefined,
        rateLimits: undefined,
      }),
    ).toBeUndefined();
  });

  it("stitches additionalDetails into other unknown error variants", () => {
    const result = projectCodexAppServerError({
      message: "internal server error",
      codexErrorInfo: "internalServerError",
      additionalDetails: "Trace id 1234",
      rateLimits: undefined,
    });
    expect(result).toBe("internal server error — Trace id 1234");
  });

  it("picks the more-saturated rate-limit window when multiple are present", () => {
    const result = projectCodexAppServerError({
      message: "rate limited",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: undefined,
      rateLimits: snapshot({
        planType: "plus",
        primary: { usedPercent: 50, windowDurationMins: 5, resetsAt: null },
        secondary: { usedPercent: 100, windowDurationMins: 120, resetsAt: null },
      }),
    });
    expect(result).toMatch(/~2 hours/);
  });
});
