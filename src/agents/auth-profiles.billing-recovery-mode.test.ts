import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAuthProfileStore, markAuthProfileFailure } from "./auth-profiles.js";

function createTempStore() {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-billing-recovery-"));
  const authPath = path.join(agentDir, "auth-profiles.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      version: 1,
      profiles: {
        "test-provider:main": {
          type: "api_key",
          provider: "test-provider",
          key: "vk-test",
        },
      },
    }),
  );
  return { agentDir, store: ensureAuthProfileStore(agentDir) };
}

describe("billingRecoveryMode", () => {
  it('"disable" (default) disables for ~5 hours', async () => {
    const { agentDir, store } = createTempStore();
    try {
      const startedAt = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "test-provider:main",
        reason: "billing",
        agentDir,
      });

      const stats = store.usageStats?.["test-provider:main"];
      expect(stats?.disabledUntil).toBeDefined();
      expect(stats?.disabledReason).toBe("billing");
      const remainingMs = (stats?.disabledUntil as number) - startedAt;
      expect(remainingMs).toBeGreaterThan(4.5 * 60 * 60 * 1000);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('"retry" applies a 5 minute cooldown', async () => {
    const { agentDir, store } = createTempStore();
    try {
      const startedAt = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "test-provider:main",
        reason: "billing",
        agentDir,
        cfg: {
          auth: { cooldowns: { billingRecoveryMode: "retry" } },
        } as never,
      });

      const stats = store.usageStats?.["test-provider:main"];
      // Should use cooldownUntil (not disabledUntil) for short retry
      expect(stats?.cooldownUntil).toBeDefined();
      expect(stats?.disabledUntil).toBeUndefined();
      expect(stats?.disabledReason).toBeUndefined();
      const remainingMs = (stats?.cooldownUntil as number) - startedAt;
      // 5 minute cooldown ± tolerance
      expect(remainingMs).toBeGreaterThan(4.5 * 60 * 1000);
      expect(remainingMs).toBeLessThan(5.5 * 60 * 1000);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('"notify" does not set any cooldown or disable', async () => {
    const { agentDir, store } = createTempStore();
    try {
      await markAuthProfileFailure({
        store,
        profileId: "test-provider:main",
        reason: "billing",
        agentDir,
        cfg: {
          auth: { cooldowns: { billingRecoveryMode: "notify" } },
        } as never,
      });

      const stats = store.usageStats?.["test-provider:main"];
      expect(stats?.disabledUntil).toBeUndefined();
      expect(stats?.disabledReason).toBeUndefined();
      expect(stats?.cooldownUntil).toBeUndefined();
      // Error count should still be recorded for diagnostics
      expect(stats?.errorCount).toBe(1);
      expect(stats?.failureCounts?.billing).toBe(1);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("switching from disable → notify clears stale disabledUntil", async () => {
    const { agentDir, store } = createTempStore();
    try {
      // Step 1: billing failure with default "disable" mode → profile disabled for hours
      await markAuthProfileFailure({
        store,
        profileId: "test-provider:main",
        reason: "billing",
        agentDir,
      });

      const afterDisable = store.usageStats?.["test-provider:main"];
      expect(afterDisable?.disabledUntil).toBeDefined();
      expect(afterDisable?.disabledReason).toBe("billing");

      // Step 2: config switches to "notify" mode → next failure must clear stale state
      await markAuthProfileFailure({
        store,
        profileId: "test-provider:main",
        reason: "billing",
        agentDir,
        cfg: {
          auth: { cooldowns: { billingRecoveryMode: "notify" } },
        } as never,
      });

      const afterNotify = store.usageStats?.["test-provider:main"];
      expect(afterNotify?.disabledUntil).toBeUndefined();
      expect(afterNotify?.disabledReason).toBeUndefined();
      expect(afterNotify?.cooldownUntil).toBeUndefined();
      // Error counts should accumulate
      expect(afterNotify?.errorCount).toBe(2);
      expect(afterNotify?.failureCounts?.billing).toBe(2);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("switching from disable → retry clears stale disabledUntil", async () => {
    const { agentDir, store } = createTempStore();
    try {
      // Step 1: billing failure with default "disable" mode → profile disabled for hours
      await markAuthProfileFailure({
        store,
        profileId: "test-provider:main",
        reason: "billing",
        agentDir,
      });

      const afterDisable = store.usageStats?.["test-provider:main"];
      expect(afterDisable?.disabledUntil).toBeDefined();
      expect(afterDisable?.disabledReason).toBe("billing");

      // Step 2: config switches to "retry" mode → must clear stale disable, set short cooldown
      const beforeRetry = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "test-provider:main",
        reason: "billing",
        agentDir,
        cfg: {
          auth: { cooldowns: { billingRecoveryMode: "retry" } },
        } as never,
      });

      const afterRetry = store.usageStats?.["test-provider:main"];
      expect(afterRetry?.disabledUntil).toBeUndefined();
      expect(afterRetry?.disabledReason).toBeUndefined();
      expect(afterRetry?.cooldownUntil).toBeDefined();
      // Should be ~5 min cooldown, not the stale hours-long disable
      const cooldownMs = (afterRetry?.cooldownUntil as number) - beforeRetry;
      expect(cooldownMs).toBeLessThan(6 * 60 * 1000);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
