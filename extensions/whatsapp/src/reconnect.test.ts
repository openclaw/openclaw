import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  computeBackoff,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_MESSAGE_TIMEOUT_MS,
  DEFAULT_RECONNECT_POLICY,
  resolveHeartbeatSeconds,
  resolveMessageTimeoutMs,
  resolveReconnectPolicy,
  sleepWithAbort,
} from "./reconnect.js";

describe("web reconnect helpers", () => {
  const cfg: OpenClawConfig = {};

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

  it("computes increasing backoff with jitter", () => {
    const policy = { ...DEFAULT_RECONNECT_POLICY, jitter: 0 };
    const first = computeBackoff(policy, 1);
    const second = computeBackoff(policy, 2);
    expect(first).toBe(policy.initialMs);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(policy.maxMs);
  });

  it("returns heartbeat default when unset", () => {
    expect(resolveHeartbeatSeconds(cfg)).toBe(DEFAULT_HEARTBEAT_SECONDS);
    expect(resolveHeartbeatSeconds(cfg, 5)).toBe(5);
  });

  it("returns message timeout default when unset", () => {
    expect(resolveMessageTimeoutMs(cfg)).toBe(DEFAULT_MESSAGE_TIMEOUT_MS);
    expect(resolveMessageTimeoutMs(cfg, 5_000)).toBe(5_000);
    expect(resolveMessageTimeoutMs({ web: { messageTimeoutMs: 7_000 } } as OpenClawConfig)).toBe(
      7_000,
    );
  });

  it("sleepWithAbort rejects on abort", async () => {
    const controller = new AbortController();
    const promise = sleepWithAbort(50, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
  });
});
