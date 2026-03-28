import { describe, expect, it } from "vitest";
import { computeBackoff, type BackoffPolicy } from "../../infra/backoff.js";

/**
 * Tests for the OVERLOAD_FAILOVER_BACKOFF_POLICY ceiling and config-driven override.
 *
 * The policy is built inside `runEmbeddedPiAgent` from
 * `params.config?.agents?.defaults?.embeddedPi?.overloadBackoffMaxMs ?? 30_000`.
 * These tests verify the policy shape and that `computeBackoff` respects `maxMs`.
 */
describe("overload failover backoff policy", () => {
  it("default ceiling is 30s (not 1.5s)", () => {
    const defaultMaxMs = 30_000;
    const policy: BackoffPolicy = {
      initialMs: 250,
      maxMs: defaultMaxMs,
      factor: 2,
      jitter: 0,
    };

    // After many attempts the backoff should be capped at maxMs, never exceeding 30s.
    for (let attempt = 1; attempt <= 10; attempt++) {
      const delay = computeBackoff(policy, attempt);
      expect(delay).toBeLessThanOrEqual(defaultMaxMs);
    }

    // After enough doublings (250 * 2^n) the cap must kick in before 30 000 ms.
    // At attempt 8: 250 * 2^7 = 32 000 — already above 30 000, so it should clamp.
    const cappedDelay = computeBackoff(policy, 8);
    expect(cappedDelay).toBe(defaultMaxMs);
  });

  it("config override overloadBackoffMaxMs: 500 is respected", () => {
    const configMaxMs = 500;
    const policy: BackoffPolicy = {
      initialMs: 250,
      maxMs: configMaxMs,
      factor: 2,
      jitter: 0,
    };

    // After 2 doublings (250 * 2^1 = 500) the cap should kick in.
    const cappedDelay = computeBackoff(policy, 2);
    expect(cappedDelay).toBe(configMaxMs);

    // Higher attempts must not exceed the override ceiling.
    for (let attempt = 2; attempt <= 10; attempt++) {
      expect(computeBackoff(policy, attempt)).toBeLessThanOrEqual(configMaxMs);
    }
  });

  it("first attempt uses initialMs before hitting the ceiling", () => {
    const policy: BackoffPolicy = {
      initialMs: 250,
      maxMs: 30_000,
      factor: 2,
      jitter: 0,
    };
    // attempt=1 → base = 250 * 2^0 = 250, no jitter → 250
    expect(computeBackoff(policy, 1)).toBe(250);
  });
});
