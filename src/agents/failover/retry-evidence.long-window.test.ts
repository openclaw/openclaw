import { describe, expect, it } from "vitest";
import { hasLongWindowRateLimitEvidence } from "./retry-evidence.js";

/**
 * Regression for #179962: a usage-limit 429 whose provider message embeds a
 * Python-style dict gets redacted to "[Malformed diagnostic JSON redacted]"
 * before hasLongWindowRateLimitEvidence runs.  The keyword check alone cannot
 * classify it; the retry controller must also reject by Retry-After magnitude.
 *
 * These tests cover the evidence layer; the controller gate is tested via the
 * extracted-function reproduction (LONG_WINDOW_RETRY_AFTER_MS = 60 000).
 */
describe("hasLongWindowRateLimitEvidence", () => {
  it("detects subscription/usage-limit keywords in raw provider text", () => {
    expect(
      hasLongWindowRateLimitEvidence(
        "Claude subscription usage limit reached (seven_day); it resets at 2026-10-22T03:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("returns false for redacted diagnostic text (the #179962 trigger)", () => {
    // After redaction the keywords are gone; the evidence layer alone cannot classify.
    expect(
      hasLongWindowRateLimitEvidence(
        "\u26a0\ufe0f [Malformed diagnostic JSON redacted]; Retry-After: 41294 seconds",
      ),
    ).toBe(false);
  });

  it("returns false for short-window throttle text", () => {
    expect(hasLongWindowRateLimitEvidence("Too many requests per minute, please retry")).toBe(false);
  });
});

describe("LONG_WINDOW_RETRY_AFTER_MS gate (controller logic)", () => {
  // Mirror the constant added to failover-retry-controller.ts
  const LONG_WINDOW_RETRY_AFTER_MS = 60_000;

  function shouldRejectLongWindow(retry: {
    reason: string;
    message?: string;
    retryAfterMs?: number;
  }): boolean {
    const rateLimit = retry.reason === "rate_limit";
    return (
      rateLimit &&
      (hasLongWindowRateLimitEvidence(retry.message) ||
        (retry.retryAfterMs !== undefined &&
          Number.isFinite(retry.retryAfterMs) &&
          retry.retryAfterMs > LONG_WINDOW_RETRY_AFTER_MS))
    );
  }

  it("rejects a redacted 429 with 11.5 h Retry-After by magnitude", () => {
    expect(
      shouldRejectLongWindow({
        reason: "rate_limit",
        message: "\u26a0\ufe0f [Malformed diagnostic JSON redacted]; Retry-After: 41294 seconds",
        retryAfterMs: 41_294_000,
      }),
    ).toBe(true);
  });

  it("still rejects raw keyword messages", () => {
    expect(
      shouldRejectLongWindow({
        reason: "rate_limit",
        message: "Claude subscription usage limit reached (seven_day)",
        retryAfterMs: 41_294_000,
      }),
    ).toBe(true);
  });

  it("does not reject a short-window 429 (5 s)", () => {
    expect(
      shouldRejectLongWindow({
        reason: "rate_limit",
        message: "Too many requests, please retry",
        retryAfterMs: 5_000,
      }),
    ).toBe(false);
  });

  it("does not reject when retryAfterMs is exactly at the threshold", () => {
    expect(
      shouldRejectLongWindow({
        reason: "rate_limit",
        message: "[Malformed diagnostic JSON redacted]",
        retryAfterMs: 60_000,
      }),
    ).toBe(false);
  });

  it("does not reject non-rate-limit reasons", () => {
    expect(
      shouldRejectLongWindow({
        reason: "server_error",
        message: "[Malformed diagnostic JSON redacted]",
        retryAfterMs: 41_294_000,
      }),
    ).toBe(false);
  });
});
