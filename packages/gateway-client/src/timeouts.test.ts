// Gateway Client tests cover timeouts behavior.
import { describe, expect, it, vi } from "vitest";
import {
  addSafeTimeoutDelayGraceMs,
  getConnectChallengeTimeoutMsFromEnv,
  MAX_SAFE_TIMEOUT_DELAY_MS,
  resolveConnectChallengeTimeoutMs,
  resolveFiniteTimeoutDelayMs,
  resolvePreauthHandshakeTimeoutMs,
  resolveSafeTimeoutDelayMs,
  startGatewayConnectTimeout,
} from "./timeouts.js";

describe("resolveSafeTimeoutDelayMs", () => {
  it.each([
    [12_345_678_901_000, 0, 60_000, 2_147_483_647],
    [1_000, 900, 60_000, 60_000],
  ])("keeps refresh deadline %i within safe timer bounds", (refreshAt, now, minMs, expected) => {
    expect(resolveSafeTimeoutDelayMs(refreshAt - now, { minMs })).toBe(expected);
  });

  it("preserves callers that intentionally allow zero-delay timers", () => {
    expect(resolveSafeTimeoutDelayMs(Number.NaN, { minMs: 0 })).toBe(0);
    expect(resolveSafeTimeoutDelayMs(-5, { minMs: 0 })).toBe(0);
  });
});

describe("addSafeTimeoutDelayGraceMs", () => {
  it("caps overflowed finite sums instead of falling back to the minimum", () => {
    expect(addSafeTimeoutDelayGraceMs(Number.MAX_VALUE, 5_000)).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });
});

describe("resolveFiniteTimeoutDelayMs", () => {
  it("uses the fallback for missing or non-finite overrides", () => {
    expect(resolveFiniteTimeoutDelayMs(undefined, 10_000, { minMs: 0 })).toBe(10_000);
    expect(resolveFiniteTimeoutDelayMs(Number.NaN, 10_000, { minMs: 0 })).toBe(10_000);
    expect(resolveFiniteTimeoutDelayMs(Number.POSITIVE_INFINITY, 10_000, { minMs: 0 })).toBe(
      10_000,
    );
  });

  it("still clamps finite overrides through safe timer bounds", () => {
    expect(resolveFiniteTimeoutDelayMs(3_000_000_000, 10_000)).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(resolveFiniteTimeoutDelayMs(-5, 10_000, { minMs: 0 })).toBe(0);
  });
});

describe("gateway client handshake timeouts", () => {
  it("allows a busy host 30 seconds without extending a stalled handshake", () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      startGatewayConnectTimeout(expired);
      expect(resolvePreauthHandshakeTimeoutMs({ env: {} })).toBe(30_000);
      expect(resolveConnectChallengeTimeoutMs(undefined, { env: {} })).toBe(30_000);
      vi.advanceTimersByTime(15_000);
      expect(expired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(15_000);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps preauth handshake timeout env and config values to the safe timer range", () => {
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: { OPENCLAW_HANDSHAKE_TIMEOUT_MS: "3000000000" },
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: {},
        configuredTimeoutMs: 3_000_000_000,
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("caps gateway connect challenge env and explicit timeouts to the safe timer range", () => {
    expect(
      getConnectChallengeTimeoutMsFromEnv({
        OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "3000000000",
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(
      resolveConnectChallengeTimeoutMs(3_000_000_000, {
        env: {},
        configuredTimeoutMs: 3_000_000_000,
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(
      resolveConnectChallengeTimeoutMs(undefined, {
        env: { OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "3000000000" },
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });
});
