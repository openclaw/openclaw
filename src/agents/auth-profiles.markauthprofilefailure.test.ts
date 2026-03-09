import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INLINE_PROFILE_PREFIX,
  calculateAuthProfileCooldownMs,
  ensureAuthProfileStore,
  isProfileInCooldown,
  markAuthProfileFailure,
} from "./auth-profiles.js";

type AuthProfileStore = ReturnType<typeof ensureAuthProfileStore>;

async function withAuthProfileStore(
  fn: (ctx: { agentDir: string; store: AuthProfileStore }) => Promise<void>,
): Promise<void> {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
  try {
    const authPath = path.join(agentDir, "auth-profiles.json");
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-default",
          },
          "openrouter:default": {
            type: "api_key",
            provider: "openrouter",
            key: "sk-or-default",
          },
        },
      }),
    );

    const store = ensureAuthProfileStore(agentDir);
    await fn({ agentDir, store });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

function expectCooldownInRange(remainingMs: number, minMs: number, maxMs: number): void {
  expect(remainingMs).toBeGreaterThan(minMs);
  expect(remainingMs).toBeLessThan(maxMs);
}

describe("markAuthProfileFailure", () => {
  it("disables billing failures for ~5 hours by default", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const startedAt = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "billing",
        agentDir,
      });

      const disabledUntil = store.usageStats?.["anthropic:default"]?.disabledUntil;
      expect(typeof disabledUntil).toBe("number");
      const remainingMs = (disabledUntil as number) - startedAt;
      expectCooldownInRange(remainingMs, 4.5 * 60 * 60 * 1000, 5.5 * 60 * 60 * 1000);
    });
  });
  it("honors per-provider billing backoff overrides", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const startedAt = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "billing",
        agentDir,
        cfg: {
          auth: {
            cooldowns: {
              billingBackoffHoursByProvider: { Anthropic: 1 },
              billingMaxHours: 2,
            },
          },
        } as never,
      });

      const disabledUntil = store.usageStats?.["anthropic:default"]?.disabledUntil;
      expect(typeof disabledUntil).toBe("number");
      const remainingMs = (disabledUntil as number) - startedAt;
      expectCooldownInRange(remainingMs, 0.8 * 60 * 60 * 1000, 1.2 * 60 * 60 * 1000);
    });
  });
  it("keeps persisted cooldownUntil unchanged across mid-window retries", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        agentDir,
      });

      const firstCooldownUntil = store.usageStats?.["anthropic:default"]?.cooldownUntil;
      expect(typeof firstCooldownUntil).toBe("number");

      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        agentDir,
      });

      const secondCooldownUntil = store.usageStats?.["anthropic:default"]?.cooldownUntil;
      expect(secondCooldownUntil).toBe(firstCooldownUntil);

      const reloaded = ensureAuthProfileStore(agentDir);
      expect(reloaded.usageStats?.["anthropic:default"]?.cooldownUntil).toBe(firstCooldownUntil);
    });
  });
  it("records overloaded failures in the cooldown bucket", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "overloaded",
        agentDir,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(typeof stats?.cooldownUntil).toBe("number");
      expect(stats?.disabledUntil).toBeUndefined();
      expect(stats?.disabledReason).toBeUndefined();
      expect(stats?.failureCounts?.overloaded).toBe(1);
    });
  });
  it("disables auth_permanent failures via disabledUntil (like billing)", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "auth_permanent",
        agentDir,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(typeof stats?.disabledUntil).toBe("number");
      expect(stats?.disabledReason).toBe("auth_permanent");
      // Should NOT set cooldownUntil (that's for transient errors)
      expect(stats?.cooldownUntil).toBeUndefined();
    });
  });
  it("resets backoff counters outside the failure window", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      const now = Date.now();
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "sk-default",
            },
          },
          usageStats: {
            "anthropic:default": {
              errorCount: 9,
              failureCounts: { billing: 3 },
              lastFailureAt: now - 48 * 60 * 60 * 1000,
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "billing",
        agentDir,
        cfg: {
          auth: { cooldowns: { failureWindowHours: 24 } },
        } as never,
      });

      expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(1);
      expect(store.usageStats?.["anthropic:default"]?.failureCounts?.billing).toBe(1);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("does not persist cooldown windows for OpenRouter profiles", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markAuthProfileFailure({
        store,
        profileId: "openrouter:default",
        reason: "rate_limit",
        agentDir,
      });

      await markAuthProfileFailure({
        store,
        profileId: "openrouter:default",
        reason: "billing",
        agentDir,
      });

      expect(store.usageStats?.["openrouter:default"]).toBeUndefined();

      const reloaded = ensureAuthProfileStore(agentDir);
      expect(reloaded.usageStats?.["openrouter:default"]).toBeUndefined();
    });
  });
});

describe("markAuthProfileFailure — inline provider profiles (#39807)", () => {
  it("auto-creates a synthetic profile for inline providers on billing failure", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const inlineProfileId = `${INLINE_PROFILE_PREFIX}minimax`;

      // No profile exists for inline provider initially
      expect(store.profiles[inlineProfileId]).toBeUndefined();

      await markAuthProfileFailure({
        store,
        profileId: inlineProfileId,
        reason: "billing",
        agentDir,
      });

      // Synthetic profile was auto-created
      expect(store.profiles[inlineProfileId]).toBeDefined();
      expect(store.profiles[inlineProfileId].type).toBe("api_key");
      expect(store.profiles[inlineProfileId].provider).toBe("minimax");

      // Billing backoff was applied
      const stats = store.usageStats?.[inlineProfileId];
      expect(typeof stats?.disabledUntil).toBe("number");
      expect(stats?.disabledReason).toBe("billing");
      expect(isProfileInCooldown(store, inlineProfileId)).toBe(true);
    });
  });

  it("applies exponential backoff on repeated billing failures for inline providers", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const inlineProfileId = `${INLINE_PROFILE_PREFIX}minimax`;

      await markAuthProfileFailure({
        store,
        profileId: inlineProfileId,
        reason: "billing",
        agentDir,
      });
      const firstDisabledUntil = store.usageStats?.[inlineProfileId]?.disabledUntil;
      expect(typeof firstDisabledUntil).toBe("number");

      // Second failure within window should not extend the existing disable window
      await markAuthProfileFailure({
        store,
        profileId: inlineProfileId,
        reason: "billing",
        agentDir,
      });
      const secondDisabledUntil = store.usageStats?.[inlineProfileId]?.disabledUntil;
      expect(secondDisabledUntil).toBe(firstDisabledUntil);
    });
  });

  it("does not create synthetic profiles for non-inline profile IDs", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const fakeProfileId = "nonexistent:provider";
      await markAuthProfileFailure({
        store,
        profileId: fakeProfileId,
        reason: "billing",
        agentDir,
      });

      // Should not auto-create — no inline: prefix
      expect(store.profiles[fakeProfileId]).toBeUndefined();
      expect(store.usageStats?.[fakeProfileId]).toBeUndefined();
    });
  });

  it("persists inline profile cooldown state to disk", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const inlineProfileId = `${INLINE_PROFILE_PREFIX}deepseek`;

      await markAuthProfileFailure({
        store,
        profileId: inlineProfileId,
        reason: "billing",
        agentDir,
      });

      // Reload from disk
      const reloaded = ensureAuthProfileStore(agentDir);
      expect(reloaded.profiles[inlineProfileId]).toBeDefined();
      expect(reloaded.profiles[inlineProfileId].provider).toBe("deepseek");
      expect(typeof reloaded.usageStats?.[inlineProfileId]?.disabledUntil).toBe("number");
      expect(isProfileInCooldown(reloaded, inlineProfileId)).toBe(true);
    });
  });
});

describe("calculateAuthProfileCooldownMs", () => {
  it("applies exponential backoff with a 1h cap", () => {
    expect(calculateAuthProfileCooldownMs(1)).toBe(60_000);
    expect(calculateAuthProfileCooldownMs(2)).toBe(5 * 60_000);
    expect(calculateAuthProfileCooldownMs(3)).toBe(25 * 60_000);
    expect(calculateAuthProfileCooldownMs(4)).toBe(60 * 60_000);
    expect(calculateAuthProfileCooldownMs(5)).toBe(60 * 60_000);
  });
});
