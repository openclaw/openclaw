// Whatsapp tests cover reconnect plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  computeBackoff,
  DEFAULT_RECONNECT_POLICY,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
} from "./reconnect.js";

describe("web reconnect helpers", () => {
  const cfg: OpenClawConfig = {};

  it("uses the configured retry budget and backoff cap", () => {
    const policy = resolveReconnectPolicy({
      channels: { whatsapp: { reconnect: { maxAttempts: 60, maxMs: 120_000 } } },
    });
    expect(policy).toEqual({ ...DEFAULT_RECONNECT_POLICY, maxAttempts: 60, maxMs: 120_000 });
    const delays = [1, 2, 3, 20].map((attempt) =>
      computeBackoff({ ...policy, jitter: 0 }, attempt),
    );
    expect(delays).toEqual([2_000, 3_600, 6_480, 120_000]);
  });

  it("preserves defaults and explicit internal tuning precedence", () => {
    expect(resolveReconnectPolicy(cfg)).toEqual(DEFAULT_RECONNECT_POLICY);
    expect(
      resolveReconnectPolicy(
        { channels: { whatsapp: { reconnect: { maxAttempts: 60, maxMs: 120_000 } } } },
        { maxAttempts: 3, maxMs: 5_000 },
      ),
    ).toMatchObject({ maxAttempts: 3, maxMs: 5_000 });
  });

  it("resolves sane reconnect defaults with clamps", () => {
    const policy = resolveReconnectPolicy(cfg, {
      initialMs: 100,
      maxMs: 5,
      factor: 20,
      jitter: 2,
      maxAttempts: -1,
    });

    expect(policy.initialMs).toBe(250); // clamped to minimum
    expect(policy.maxMs).toBeGreaterThanOrEqual(policy.initialMs);
    expect(policy.factor).toBeLessThanOrEqual(10);
    expect(policy.jitter).toBeLessThanOrEqual(1);
    expect(policy.maxAttempts).toBeGreaterThanOrEqual(0);
  });

  it("returns heartbeat default when unset", () => {
    expect(resolveHeartbeatSeconds(cfg)).toBe(60);
    expect(resolveHeartbeatSeconds(cfg, 5)).toBe(5);
  });
});
