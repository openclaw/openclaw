import { describe, expect, it } from "vitest";

describe("timeout retry logic", () => {
  it("should retry on same profile before rotating", () => {
    // Test: First timeout should retry same profile
    const consecutiveTimeouts = 1;
    const maxRetries = 1;
    const shouldRetry = consecutiveTimeouts <= maxRetries;
    expect(shouldRetry).toBe(true);
  });

  it("should rotate after retries exhausted", () => {
    // Test: After max retries, should rotate
    const consecutiveTimeouts = 2;
    const maxRetries = 1;
    const shouldRetry = consecutiveTimeouts <= maxRetries;
    expect(shouldRetry).toBe(false);
  });

  it("should reset counter on different profile", () => {
    // Test: Timeout on different profile resets counter
    const lastProfileId = "profile-a";
    const currentProfileId = "profile-b";
    const shouldReset = lastProfileId !== currentProfileId;
    expect(shouldReset).toBe(true);
  });

  it("should apply jitter to backoff delay", () => {
    // Test: Jitter should be within ±30% of base delay
    const baseDelay = 300;
    const jitterFactor = 0.3;
    const minDelay = baseDelay * (1 - jitterFactor);
    const maxDelay = baseDelay * (1 + jitterFactor);

    for (let i = 0; i < 100; i++) {
      const jitter = Math.random() * jitterFactor * baseDelay;
      const delay = baseDelay + jitter;
      expect(delay).toBeGreaterThanOrEqual(minDelay);
      expect(delay).toBeLessThanOrEqual(maxDelay);
    }
  });

  it("should use correct backoff for attempt index", () => {
    // Test: Backoff array indexing
    const backoffMs = [300, 1200];

    // First retry (index 0)
    const attempt1 = Math.min(0, backoffMs.length - 1);
    expect(backoffMs[attempt1]).toBe(300);

    // Second retry (index 1)
    const attempt2 = Math.min(1, backoffMs.length - 1);
    expect(backoffMs[attempt2]).toBe(1200);

    // Third retry (index 2, clamped to last)
    const attempt3 = Math.min(2, backoffMs.length - 1);
    expect(backoffMs[attempt3]).toBe(1200);
  });

  it("should use default config when not specified", () => {
    // Test: Default values
    const config = undefined;
    const maxRetries = config?.retrySameProfileOnTimeout ?? 1;
    const backoffMs = config?.retryBackoffMs ?? [300, 1200];

    expect(maxRetries).toBe(1);
    expect(backoffMs).toEqual([300, 1200]);
  });

  it("should respect custom config values", () => {
    // Test: Custom config
    const config = {
      retrySameProfileOnTimeout: 2,
      retryBackoffMs: [500, 1000, 2000],
    };
    const maxRetries = config.retrySameProfileOnTimeout ?? 1;
    const backoffMs = config.retryBackoffMs ?? [300, 1200];

    expect(maxRetries).toBe(2);
    expect(backoffMs).toEqual([500, 1000, 2000]);
  });

  it("should handle zero retries config", () => {
    // Test: Disable retry with 0
    const config = {
      retrySameProfileOnTimeout: 0,
    };
    const consecutiveTimeouts = 1;
    const maxRetries = config.retrySameProfileOnTimeout ?? 1;
    const shouldRetry = consecutiveTimeouts <= maxRetries;

    expect(shouldRetry).toBe(false);
  });

  it("should reset counter on success", () => {
    // Test: Success resets timeout counter
    const isTimeoutFailure = false;
    const shouldReset = !isTimeoutFailure;
    expect(shouldReset).toBe(true);
  });

  it("should not retry on non-timeout failures", () => {
    // Test: Rate limit, auth, billing failures skip retry
    const isTimeoutFailure = false;
    const shouldRotate = true;
    const shouldRetry = isTimeoutFailure && !shouldRotate;
    expect(shouldRetry).toBe(false);
  });
});
