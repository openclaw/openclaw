import { describe, it, expect, vi } from "vitest";
import {
  computeRetryDelay,
  isRetryableRound,
  RETRYABLE_REASONS,
  DEFAULT_RETRY_CONFIG,
  classifyError,
  extractRetryAfterMs,
  retryWithBackoff,
} from "../retry-backoff.js";

describe("RETRYABLE_REASONS", () => {
  it("contains expected reason strings", () => {
    expect(RETRYABLE_REASONS).toContain("rate_limit");
    expect(RETRYABLE_REASONS).toContain("timeout");
    expect(RETRYABLE_REASONS).toContain("unknown");
  });
});

describe("computeRetryDelay", () => {
  it("returns base delay on first attempt", () => {
    const delay = computeRetryDelay(0, {
      baseDelayMs: 5_000,
      maxDelayMs: 120_000,
      maxRounds: 5,
    });
    expect(delay).toBe(5_000);
  });

  it("doubles delay with each attempt (exponential back-off)", () => {
    const cfg = { baseDelayMs: 1_000, maxDelayMs: 60_000, maxRounds: 5 };
    expect(computeRetryDelay(1, cfg)).toBe(2_000);
    expect(computeRetryDelay(2, cfg)).toBe(4_000);
    expect(computeRetryDelay(3, cfg)).toBe(8_000);
  });

  it("caps delay at maxDelayMs", () => {
    const cfg = { baseDelayMs: 1_000, maxDelayMs: 3_000, maxRounds: 10 };
    expect(computeRetryDelay(5, cfg)).toBe(3_000);
  });
});

describe("isRetryableRound", () => {
  it("returns true for retryable reason string within round limit", () => {
    expect(isRetryableRound("rate_limit", 0, DEFAULT_RETRY_CONFIG)).toBe(true);
    expect(isRetryableRound("timeout", 1, DEFAULT_RETRY_CONFIG)).toBe(true);
  });

  it("returns true for attempts array with retryable reasons", () => {
    const attempts = [{ reason: "rate_limit" }, { reason: "timeout" }];
    expect(isRetryableRound(attempts, 0, DEFAULT_RETRY_CONFIG)).toBe(true);
  });

  it("returns false when round exceeds maxRounds", () => {
    const cfg = { ...DEFAULT_RETRY_CONFIG, maxRounds: 2 };
    expect(isRetryableRound("rate_limit", 3, cfg)).toBe(false);
  });

  it("returns false for non-retryable reasons", () => {
    expect(isRetryableRound("invalid_api_key", 0, DEFAULT_RETRY_CONFIG)).toBe(false);
    expect(isRetryableRound("content_policy", 1, DEFAULT_RETRY_CONFIG)).toBe(false);
  });

  it("returns false for empty attempts array", () => {
    expect(isRetryableRound([], 0, DEFAULT_RETRY_CONFIG)).toBe(false);
  });

  it("returns false when any attempt is non-retryable", () => {
    const attempts = [{ reason: "rate_limit" }, { reason: "invalid_api_key" }];
    expect(isRetryableRound(attempts, 0, DEFAULT_RETRY_CONFIG)).toBe(false);
  });
});

// ─── classifyError ──────────────────────────────────────────────────────────

describe("classifyError", () => {
  it("returns rate_limit for status 429", () => {
    expect(classifyError({ status: 429 })).toBe("rate_limit");
    expect(classifyError({ statusCode: 429 })).toBe("rate_limit");
  });

  it("returns rate_limit for error with reason field", () => {
    expect(classifyError({ reason: "rate_limit" })).toBe("rate_limit");
  });

  it("returns timeout for status 408/502/503/504", () => {
    expect(classifyError({ status: 408 })).toBe("timeout");
    expect(classifyError({ status: 502 })).toBe("timeout");
    expect(classifyError({ status: 503 })).toBe("timeout");
    expect(classifyError({ status: 504 })).toBe("timeout");
  });

  it("returns timeout for timeout-like error messages", () => {
    expect(classifyError(new Error("request timed out"))).toBe("timeout");
    expect(classifyError(new Error("ECONNRESET"))).toBe("timeout");
    expect(classifyError(new Error("ETIMEDOUT"))).toBe("timeout");
    expect(classifyError(new Error("ECONNABORTED"))).toBe("timeout");
  });

  it("returns undefined for non-retryable errors", () => {
    expect(classifyError(new Error("invalid api key"))).toBeUndefined();
    expect(classifyError({ status: 400 })).toBeUndefined();
    expect(classifyError({ status: 401 })).toBeUndefined();
  });

  it("returns undefined for null/undefined/primitive", () => {
    expect(classifyError(null)).toBeUndefined();
    expect(classifyError(undefined)).toBeUndefined();
    expect(classifyError("string")).toBeUndefined();
  });
});

// ─── extractRetryAfterMs ────────────────────────────────────────────────────

describe("extractRetryAfterMs", () => {
  it("extracts retryAfterMs directly", () => {
    expect(extractRetryAfterMs({ retryAfterMs: 5000 })).toBe(5000);
  });

  it("converts retryAfter in seconds to ms", () => {
    expect(extractRetryAfterMs({ retryAfter: 3 })).toBe(3000);
  });

  it("converts string seconds to ms", () => {
    expect(extractRetryAfterMs({ retryAfter: "2" })).toBe(2000);
  });

  it("extracts from headers object", () => {
    expect(extractRetryAfterMs({ headers: { "retry-after": 5 } })).toBe(5000);
  });

  it("returns undefined when no retry-after info", () => {
    expect(extractRetryAfterMs({})).toBeUndefined();
    expect(extractRetryAfterMs(null)).toBeUndefined();
  });
});

// ─── retryWithBackoff ───────────────────────────────────────────────────────

describe("retryWithBackoff", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 error and succeeds", async () => {
    const err429 = Object.assign(new Error("rate limited"), { status: 429 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err429)
      .mockResolvedValue("recovered");

    const result = await retryWithBackoff(fn, {
      config: { baseDelayMs: 10, maxDelayMs: 100, maxRounds: 3 },
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on timeout error", async () => {
    const errTimeout = new Error("request timed out");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(errTimeout)
      .mockResolvedValue("ok");

    const result = await retryWithBackoff(fn, {
      config: { baseDelayMs: 10, maxDelayMs: 100, maxRounds: 3 },
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws non-retryable errors immediately", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("invalid api key"));
    await expect(
      retryWithBackoff(fn, { config: { baseDelayMs: 10, maxDelayMs: 100, maxRounds: 3 } }),
    ).rejects.toThrow("invalid api key");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after maxRounds exhausted", async () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      retryWithBackoff(fn, { config: { maxRounds: 2, baseDelayMs: 10, maxDelayMs: 100 } }),
    ).rejects.toThrow("rate limited");
    // initial + 2 retries = 3 total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls onRetry callback before each retry", async () => {
    const err = Object.assign(new Error("429"), { status: 429 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const onRetry = vi.fn();
    await retryWithBackoff(fn, {
      config: { baseDelayMs: 10, maxDelayMs: 100, maxRounds: 5 },
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ round: 0, reason: "rate_limit" }),
    );
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ round: 1, reason: "rate_limit" }),
    );
  });

  it("respects Retry-After header", async () => {
    const err = Object.assign(new Error("429"), { status: 429, retryAfterMs: 50 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const start = Date.now();
    await retryWithBackoff(fn, {
      config: { baseDelayMs: 10, maxDelayMs: 5000, maxRounds: 3 },
    });
    const elapsed = Date.now() - start;
    // Should wait at least 50ms (retryAfterMs is larger than 10ms baseDelay)
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it("respects AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();

    const err = Object.assign(new Error("429"), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      retryWithBackoff(fn, {
        config: { baseDelayMs: 10, maxDelayMs: 100, maxRounds: 3 },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("handles 502/503 as retryable", async () => {
    const err = Object.assign(new Error("bad gateway"), { status: 502 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const result = await retryWithBackoff(fn, {
      config: { baseDelayMs: 10, maxDelayMs: 100, maxRounds: 2 },
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
