import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  clearCircuitBreakerErrors,
  executeCircuitBreakerActions,
  isCircuitBreakerTripped,
  recordCircuitBreakerError,
} from "./state.js";
import type { CircuitBreakerConfig } from "./types.js";

function makeEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: crypto.randomUUID(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("isCircuitBreakerTripped", () => {
  it("returns false when config is undefined", () => {
    const entry = makeEntry({ cbTrippedAt: Date.now() });
    expect(isCircuitBreakerTripped(entry, undefined)).toBe(false);
  });

  it("returns false when tripped with pause but no cooldownUntil (uses default threshold)", () => {
    const entry = makeEntry({ cbTrippedAt: Date.now() });
    // Config without consecutiveErrors uses default threshold; tripped but
    // no cooldownUntil means actions haven't executed yet — not blocking.
    expect(isCircuitBreakerTripped(entry, { action: "pause" })).toBe(false);
  });

  it("returns false when not tripped", () => {
    const entry = makeEntry();
    const config: CircuitBreakerConfig = { consecutiveErrors: 5, action: "pause" };
    expect(isCircuitBreakerTripped(entry, config)).toBe(false);
  });

  it("returns true when tripped with pause and cooldown not expired", () => {
    const now = Date.now();
    const entry = makeEntry({
      cbTrippedAt: now - 1000,
      cbCooldownUntil: now + 60_000,
    });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 3,
      action: "pause",
      cooldownMinutes: 5,
    };
    expect(isCircuitBreakerTripped(entry, config, now)).toBe(true);
  });

  it("returns false when cooldown has expired (half-open)", () => {
    const now = Date.now();
    const entry = makeEntry({
      cbTrippedAt: now - 120_000,
      cbCooldownUntil: now - 1000,
    });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 3,
      action: "pause",
      cooldownMinutes: 1,
    };
    expect(isCircuitBreakerTripped(entry, config, now)).toBe(false);
  });

  it("returns false for alert-only action (no blocking)", () => {
    const now = Date.now();
    const entry = makeEntry({ cbTrippedAt: now - 1000 });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 3,
      action: "alert",
    };
    expect(isCircuitBreakerTripped(entry, config, now)).toBe(false);
  });

  it("returns false for reset action (session should have been reset)", () => {
    const entry = makeEntry({ cbTrippedAt: Date.now() });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 3,
      action: "reset",
    };
    expect(isCircuitBreakerTripped(entry, config)).toBe(false);
  });
});

describe("recordCircuitBreakerError", () => {
  it("does nothing when config is undefined", () => {
    const entry = makeEntry();
    const result = recordCircuitBreakerError(entry, undefined, "timeout");
    expect(result.tripped).toBe(false);
    expect(entry.cbErrorCount).toBeUndefined();
  });

  it("uses default threshold when consecutiveErrors is not set", () => {
    const entry = makeEntry();
    const result = recordCircuitBreakerError(entry, { action: "pause" }, "timeout", 1000);
    expect(result.tripped).toBe(false);
    // Should record the error using default threshold of 5.
    expect(entry.cbErrorCount).toBe(1);
    expect(entry.cbLastErrorAt).toBe(1000);
  });

  it("increments error count", () => {
    const entry = makeEntry();
    const config: CircuitBreakerConfig = { consecutiveErrors: 5 };
    recordCircuitBreakerError(entry, config, "timeout", 1000);
    expect(entry.cbErrorCount).toBe(1);
    expect(entry.cbLastErrorAt).toBe(1000);
    expect(entry.cbLastErrorReason).toBe("timeout");
  });

  it("trips when threshold is reached", () => {
    const entry = makeEntry({ cbErrorCount: 4 });
    const config: CircuitBreakerConfig = { consecutiveErrors: 5 };
    const result = recordCircuitBreakerError(entry, config, "rate_limit", 2000);
    expect(result.tripped).toBe(true);
    expect(entry.cbErrorCount).toBe(5);
    expect(entry.cbTrippedAt).toBe(2000);
  });

  it("does not trip below threshold", () => {
    const entry = makeEntry({ cbErrorCount: 2 });
    const config: CircuitBreakerConfig = { consecutiveErrors: 5 };
    const result = recordCircuitBreakerError(entry, config, "timeout");
    expect(result.tripped).toBe(false);
    expect(entry.cbErrorCount).toBe(3);
    expect(entry.cbTrippedAt).toBeUndefined();
  });

  it("handles consecutive calls correctly", () => {
    const entry = makeEntry();
    const config: CircuitBreakerConfig = { consecutiveErrors: 3 };
    expect(recordCircuitBreakerError(entry, config, "timeout").tripped).toBe(false);
    expect(entry.cbErrorCount).toBe(1);
    expect(recordCircuitBreakerError(entry, config, "timeout").tripped).toBe(false);
    expect(entry.cbErrorCount).toBe(2);
    expect(recordCircuitBreakerError(entry, config, "timeout").tripped).toBe(true);
    expect(entry.cbErrorCount).toBe(3);
  });
});

describe("clearCircuitBreakerErrors", () => {
  it("clears all cb fields", () => {
    const entry = makeEntry({
      cbErrorCount: 5,
      cbLastErrorAt: 1000,
      cbLastErrorReason: "timeout",
      cbTrippedAt: 2000,
      cbCooldownUntil: 3000,
    });
    clearCircuitBreakerErrors(entry);
    expect(entry.cbErrorCount).toBeUndefined();
    expect(entry.cbLastErrorAt).toBeUndefined();
    expect(entry.cbLastErrorReason).toBeUndefined();
    expect(entry.cbTrippedAt).toBeUndefined();
    expect(entry.cbCooldownUntil).toBeUndefined();
  });

  it("has no side effects on entry without cb fields", () => {
    const entry = makeEntry();
    const sessionId = entry.sessionId;
    clearCircuitBreakerErrors(entry);
    expect(entry.sessionId).toBe(sessionId);
    expect(entry.cbErrorCount).toBeUndefined();
  });
});

describe("executeCircuitBreakerActions", () => {
  const baseCfg = {} as Parameters<typeof executeCircuitBreakerActions>[0]["cfg"];

  it("executes pause action with correct cooldown", async () => {
    const now = 100_000;
    const entry = makeEntry({ cbTrippedAt: now, cbErrorCount: 5 });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 5,
      action: "pause",
      cooldownMinutes: 10,
    };
    await executeCircuitBreakerActions({
      entry,
      config,
      sessionKey: "test:main",
      agentId: "test",
      cfg: baseCfg,
      now,
    });
    expect(entry.cbCooldownUntil).toBe(now + 10 * 60_000);
  });

  it("executes reset action — clears session and cb state", async () => {
    const entry = makeEntry({
      cbTrippedAt: Date.now(),
      cbErrorCount: 5,
      cbLastErrorReason: "timeout",
      compactionCount: 3,
      totalTokens: 50000,
      systemSent: true,
    });
    const originalId = entry.sessionId;
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 5,
      action: "reset",
    };
    await executeCircuitBreakerActions({
      entry,
      config,
      sessionKey: "test:main",
      agentId: "test",
      cfg: baseCfg,
    });
    expect(entry.sessionId).not.toBe(originalId);
    expect(entry.systemSent).toBe(false);
    expect(entry.compactionCount).toBeUndefined();
    expect(entry.totalTokens).toBeUndefined();
    expect(entry.cbErrorCount).toBeUndefined();
    expect(entry.cbTrippedAt).toBeUndefined();
  });

  it("executes combined alert+reset in order", async () => {
    const entry = makeEntry({
      cbTrippedAt: Date.now(),
      cbErrorCount: 5,
      cbLastErrorReason: "timeout",
    });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 5,
      action: ["alert", "reset"],
      alertChannel: "telegram",
      alertTo: "+1234567890",
    };
    // Alert delivery will fail (no real deps) but should not block reset.
    await executeCircuitBreakerActions({
      entry,
      config,
      sessionKey: "test:main",
      agentId: "test",
      cfg: baseCfg,
    });
    // Reset should have happened despite alert failure.
    expect(entry.cbErrorCount).toBeUndefined();
    expect(entry.cbTrippedAt).toBeUndefined();
  });

  it("reset takes priority over pause when both configured", async () => {
    const now = 100_000;
    const entry = makeEntry({ cbTrippedAt: now, cbErrorCount: 5 });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 5,
      action: ["reset", "pause"],
      cooldownMinutes: 30,
    };
    await executeCircuitBreakerActions({
      entry,
      config,
      sessionKey: "test:main",
      agentId: "test",
      cfg: baseCfg,
      now,
    });
    // Reset clears cb state, pause should be skipped.
    expect(entry.cbCooldownUntil).toBeUndefined();
    expect(entry.cbTrippedAt).toBeUndefined();
  });

  it("alert-only clears tripped state after execution", async () => {
    const entry = makeEntry({ cbTrippedAt: Date.now(), cbErrorCount: 5 });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 5,
      action: "alert",
    };
    await executeCircuitBreakerActions({
      entry,
      config,
      sessionKey: "test:main",
      agentId: "test",
      cfg: baseCfg,
    });
    expect(entry.cbTrippedAt).toBeUndefined();
    // Error count is preserved (alert doesn't reset the session).
    expect(entry.cbErrorCount).toBe(5);
  });

  it("skips alert when alertChannel/alertTo not configured", async () => {
    const entry = makeEntry({ cbTrippedAt: Date.now(), cbErrorCount: 5 });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 5,
      action: "alert",
    };
    // Should not throw.
    await executeCircuitBreakerActions({
      entry,
      config,
      sessionKey: "test:main",
      agentId: "test",
      cfg: baseCfg,
    });
  });

  it("uses default cooldown when cooldownMinutes not configured", async () => {
    const now = 100_000;
    const entry = makeEntry({ cbTrippedAt: now, cbErrorCount: 5 });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 5,
      action: "pause",
    };
    await executeCircuitBreakerActions({
      entry,
      config,
      sessionKey: "test:main",
      agentId: "test",
      cfg: baseCfg,
      now,
    });
    expect(entry.cbCooldownUntil).toBe(now + 30 * 60_000);
  });
});

describe("half-open flow", () => {
  it("success after cooldown expiry closes the circuit", () => {
    const now = Date.now();
    const entry = makeEntry({
      cbTrippedAt: now - 120_000,
      cbCooldownUntil: now - 1000,
      cbErrorCount: 5,
    });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 5,
      action: "pause",
      cooldownMinutes: 1,
    };
    // Half-open: not tripped.
    expect(isCircuitBreakerTripped(entry, config, now)).toBe(false);
    // Simulate successful run.
    clearCircuitBreakerErrors(entry);
    expect(entry.cbErrorCount).toBeUndefined();
    expect(entry.cbTrippedAt).toBeUndefined();
    expect(entry.cbCooldownUntil).toBeUndefined();
  });

  it("failure after cooldown expiry re-trips the circuit", () => {
    const now = Date.now();
    const entry = makeEntry({
      cbTrippedAt: now - 120_000,
      cbCooldownUntil: now - 1000,
      cbErrorCount: 4,
    });
    const config: CircuitBreakerConfig = {
      consecutiveErrors: 5,
      action: "pause",
      cooldownMinutes: 1,
    };
    // Half-open: not tripped.
    expect(isCircuitBreakerTripped(entry, config, now)).toBe(false);
    // Simulate failure.
    const result = recordCircuitBreakerError(entry, config, "timeout", now);
    expect(result.tripped).toBe(true);
    expect(entry.cbTrippedAt).toBe(now);
  });
});
