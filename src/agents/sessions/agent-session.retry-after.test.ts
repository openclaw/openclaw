import { describe, expect, it } from "vitest";
import { resolveAutoRetryDelayMs } from "./agent-session.js";

describe("resolveAutoRetryDelayMs", () => {
  it("falls back to pure exponential backoff when no Retry-After is present", () => {
    expect(resolveAutoRetryDelayMs({ attempt: 1, baseDelayMs: 2000 })).toBe(2000);
    expect(resolveAutoRetryDelayMs({ attempt: 2, baseDelayMs: 2000 })).toBe(4000);
    expect(resolveAutoRetryDelayMs({ attempt: 3, baseDelayMs: 2000 })).toBe(8000);
  });

  it("uses the server Retry-After as a lower bound when it exceeds the exponential delay", () => {
    // 30s server cooldown on the first attempt (exponential would be 2s).
    expect(resolveAutoRetryDelayMs({ attempt: 1, baseDelayMs: 2000, retryAfterSeconds: 30 })).toBe(
      30_000,
    );
  });

  it("keeps the exponential delay when it already exceeds the server Retry-After", () => {
    // attempt 3 -> exponential 8s dominates a 1s hint.
    expect(resolveAutoRetryDelayMs({ attempt: 3, baseDelayMs: 2000, retryAfterSeconds: 1 })).toBe(
      8000,
    );
  });

  it("does not shorten Retry-After values longer than one minute", () => {
    expect(resolveAutoRetryDelayMs({ attempt: 1, baseDelayMs: 2000, retryAfterSeconds: 120 })).toBe(
      120_000,
    );
    expect(resolveAutoRetryDelayMs({ attempt: 1, baseDelayMs: 2000, retryAfterSeconds: 900 })).toBe(
      900_000,
    );
  });

  it("clamps pathological Retry-After values to a 24h safety ceiling (avoids setTimeout overflow)", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        retryAfterSeconds: 60 * 60 * 24 * 7,
      }),
    ).toBe(dayMs);
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        retryAfterSeconds: Number.POSITIVE_INFINITY,
      }),
    ).toBe(dayMs);
  });

  it("ignores invalid Retry-After values and uses the exponential delay", () => {
    expect(
      resolveAutoRetryDelayMs({ attempt: 2, baseDelayMs: 2000, retryAfterSeconds: Number.NaN }),
    ).toBe(4000);
    expect(resolveAutoRetryDelayMs({ attempt: 2, baseDelayMs: 2000, retryAfterSeconds: -5 })).toBe(
      4000,
    );
    expect(resolveAutoRetryDelayMs({ attempt: 2, baseDelayMs: 2000, retryAfterSeconds: 0 })).toBe(
      4000,
    );
  });
});
