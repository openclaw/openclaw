import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
} from "./auth-profiles.js";

describe("markAuthProfileFailure", () => {
  it("disables billing failures for ~5 hours by default", async () => {
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
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
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
      expect(remainingMs).toBeGreaterThan(4.5 * 60 * 60 * 1000);
      expect(remainingMs).toBeLessThan(5.5 * 60 * 60 * 1000);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
  it("honors per-provider billing backoff overrides", async () => {
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
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
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
      expect(remainingMs).toBeGreaterThan(0.8 * 60 * 60 * 1000);
      expect(remainingMs).toBeLessThan(1.2 * 60 * 60 * 1000);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
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

  it("rate_limit with modelId sets model-scoped cooldown, not profile-level", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "google:default": {
              type: "api_key",
              provider: "google",
              key: "key-1",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        modelId: "gemini-3-flash",
      });

      const stats = store.usageStats?.["google:default"];
      // Profile-level cooldownUntil should NOT be set
      expect(stats?.cooldownUntil).toBeUndefined();
      // Model-scoped cooldown should be set
      const modelEntry = stats?.modelCooldowns?.["gemini-3-flash"];
      expect(modelEntry).toBeDefined();
      expect(typeof modelEntry?.cooldownUntil).toBe("number");
      expect(modelEntry!.errorCount).toBe(1);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("model-scoped cooldown blocks only the specific model", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "google:default": {
              type: "api_key",
              provider: "google",
              key: "key-1",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        modelId: "gemini-3-flash",
      });

      // The rate-limited model should be in cooldown
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(true);
      // A different model on the same profile should NOT be in cooldown
      expect(isProfileInCooldown(store, "google:default", "gemini-2.5-flash-lite")).toBe(false);
      // Profile-level check (no modelId) should NOT be in cooldown
      expect(isProfileInCooldown(store, "google:default")).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("auth failure still sets profile-level cooldown even with modelId", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "google:default": {
              type: "api_key",
              provider: "google",
              key: "key-1",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "auth",
        agentDir,
        modelId: "gemini-3-flash",
      });

      const stats = store.usageStats?.["google:default"];
      // Auth errors should set profile-level cooldown, not model-scoped
      expect(typeof stats?.cooldownUntil).toBe("number");
      expect(stats?.modelCooldowns).toBeUndefined();
      // All models should be blocked
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(true);
      expect(isProfileInCooldown(store, "google:default", "gemini-2.5-flash-lite")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("markAuthProfileUsed clears model-scoped cooldowns", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "google:default": {
              type: "api_key",
              provider: "google",
              key: "key-1",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        modelId: "gemini-3-flash",
      });
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(true);

      await markAuthProfileUsed({
        store,
        profileId: "google:default",
        agentDir,
      });

      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(false);
      expect(store.usageStats?.["google:default"]?.modelCooldowns).toBeUndefined();
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
