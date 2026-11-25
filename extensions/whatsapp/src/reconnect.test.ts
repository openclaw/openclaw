// Whatsapp tests cover reconnect plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveHeartbeatSeconds, resolveReconnectPolicy } from "./reconnect.js";

describe("web reconnect helpers", () => {
  it("resolves sane reconnect defaults with clamps", () => {
    const policy = resolveReconnectPolicy({
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
    expect(resolveHeartbeatSeconds()).toBe(60);
    expect(resolveHeartbeatSeconds(5)).toBe(5);
  });
});
