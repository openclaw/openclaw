import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  clearAuthProfileCooldown,
  getModelCooldownUntil,
} from "./auth-profiles.js";

describe("per-model cooldown tracking", () => {
  it("rate_limit error with model sets model-specific cooldown, not profile-wide", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      const startedAt = Date.now();

      // Mark rate limit failure for gemini-3-flash
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-flash",
      });

      // Model-specific cooldown should be set
      const stats = store.usageStats?.["google:default"];
      expect(stats?.modelCooldowns?.["gemini-3-flash"]).toBeDefined();
      expect(stats?.modelCooldowns?.["gemini-3-flash"]).toBeGreaterThan(startedAt);

      // Profile-level cooldown should NOT be set
      expect(stats?.cooldownUntil).toBeUndefined();

      // Profile should be in cooldown for gemini-3-flash
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(true);

      // Profile should NOT be in cooldown for other models
      expect(isProfileInCooldown(store, "google:default", "gemini-2.5-flash-lite")).toBe(false);
      expect(isProfileInCooldown(store, "google:default", "gemini-3-pro-preview")).toBe(false);

      // Profile without model specified should NOT be in cooldown
      expect(isProfileInCooldown(store, "google:default")).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("auth error sets profile-wide cooldown, blocking all models", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      const startedAt = Date.now();

      // Mark auth failure (should be profile-wide)
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "auth",
        agentDir,
      });

      // Profile-level cooldown should be set
      const stats = store.usageStats?.["google:default"];
      expect(stats?.cooldownUntil).toBeDefined();
      expect(stats?.cooldownUntil).toBeGreaterThan(startedAt);

      // Model-specific cooldowns should NOT be set
      expect(stats?.modelCooldowns).toBeUndefined();

      // Profile should be in cooldown for ALL models
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(true);
      expect(isProfileInCooldown(store, "google:default", "gemini-2.5-flash-lite")).toBe(true);
      expect(isProfileInCooldown(store, "google:default")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("billing error sets profile-wide disabled status, blocking all models", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      const startedAt = Date.now();

      // Mark billing failure (should be profile-wide disabled)
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "billing",
        agentDir,
      });

      // Profile should be disabled
      const stats = store.usageStats?.["google:default"];
      expect(stats?.disabledUntil).toBeDefined();
      expect(stats?.disabledUntil).toBeGreaterThan(startedAt);
      expect(stats?.disabledReason).toBe("billing");

      // Profile should be in cooldown for ALL models
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(true);
      expect(isProfileInCooldown(store, "google:default", "gemini-2.5-flash-lite")).toBe(true);
      expect(isProfileInCooldown(store, "google:default")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("multiple models can have independent cooldowns", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);

      // Mark rate limit for two different models
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-flash",
      });
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-pro-preview",
      });

      // Both models should have cooldowns
      const stats = store.usageStats?.["google:default"];
      expect(stats?.modelCooldowns?.["gemini-3-flash"]).toBeDefined();
      expect(stats?.modelCooldowns?.["gemini-3-pro-preview"]).toBeDefined();

      // Both models should be in cooldown
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(true);
      expect(isProfileInCooldown(store, "google:default", "gemini-3-pro-preview")).toBe(true);

      // Other models should NOT be in cooldown
      expect(isProfileInCooldown(store, "google:default", "gemini-2.5-flash-lite")).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("markAuthProfileUsed with model clears only that model's cooldown", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);

      // Mark rate limit for two different models
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-flash",
      });
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-pro-preview",
      });

      // Mark success for gemini-3-flash
      await markAuthProfileUsed({
        store,
        profileId: "google:default",
        agentDir,
        model: "gemini-3-flash",
      });

      // gemini-3-flash cooldown should be cleared
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(false);

      // gemini-3-pro-preview should still be in cooldown
      expect(isProfileInCooldown(store, "google:default", "gemini-3-pro-preview")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("clearAuthProfileCooldown with model clears only that model's cooldown", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);

      // Mark rate limit for two different models
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-flash",
      });
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-pro-preview",
      });

      // Clear cooldown for gemini-3-flash only
      await clearAuthProfileCooldown({
        store,
        profileId: "google:default",
        agentDir,
        model: "gemini-3-flash",
      });

      // gemini-3-flash cooldown should be cleared
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(false);

      // gemini-3-pro-preview should still be in cooldown
      expect(isProfileInCooldown(store, "google:default", "gemini-3-pro-preview")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("clearAuthProfileCooldown without model clears all cooldowns", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);

      // Mark rate limit for multiple models
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-flash",
      });
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-pro-preview",
      });

      // Clear all cooldowns
      await clearAuthProfileCooldown({
        store,
        profileId: "google:default",
        agentDir,
      });

      // All model cooldowns should be cleared
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(false);
      expect(isProfileInCooldown(store, "google:default", "gemini-3-pro-preview")).toBe(false);
      expect(store.usageStats?.["google:default"]?.modelCooldowns).toBeUndefined();
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("getModelCooldownUntil returns correct value for model with cooldown", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      const startedAt = Date.now();

      // Mark rate limit for gemini-3-flash
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-flash",
      });

      // getModelCooldownUntil should return cooldown time for gemini-3-flash
      const cooldownUntil = getModelCooldownUntil(store, "google:default", "gemini-3-flash");
      expect(cooldownUntil).toBeDefined();
      expect(cooldownUntil).toBeGreaterThan(startedAt);

      // getModelCooldownUntil should return null for models without cooldown
      expect(getModelCooldownUntil(store, "google:default", "gemini-2.5-flash-lite")).toBeNull();
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("model-specific cooldown uses exponential backoff per model", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);

      // First failure: 1 minute cooldown
      const startedAt1 = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-flash",
      });
      const cooldown1 = store.usageStats?.["google:default"]?.modelCooldowns?.["gemini-3-flash"];
      expect(cooldown1).toBeDefined();
      const duration1 = (cooldown1 as number) - startedAt1;
      expect(duration1).toBeGreaterThan(50 * 1000); // ~1 min
      expect(duration1).toBeLessThan(70 * 1000);

      // Second failure: 5 minute cooldown
      const startedAt2 = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        model: "gemini-3-flash",
      });
      const cooldown2 = store.usageStats?.["google:default"]?.modelCooldowns?.["gemini-3-flash"];
      const duration2 = (cooldown2 as number) - startedAt2;
      expect(duration2).toBeGreaterThan(4 * 60 * 1000); // ~5 min
      expect(duration2).toBeLessThan(6 * 60 * 1000);

      // Model error count should be 2
      expect(store.usageStats?.["google:default"]?.modelErrorCounts?.["gemini-3-flash"]).toBe(2);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("rate_limit without model falls back to profile-level cooldown", async () => {
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
              key: "key-default",
            },
          },
        }),
      );

      const store = ensureAuthProfileStore(agentDir);
      const startedAt = Date.now();

      // Mark rate limit without model (backwards compatibility)
      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        agentDir,
        // No model specified
      });

      // Profile-level cooldown should be set
      const stats = store.usageStats?.["google:default"];
      expect(stats?.cooldownUntil).toBeDefined();
      expect(stats?.cooldownUntil).toBeGreaterThan(startedAt);

      // Model-specific cooldowns should NOT be set
      expect(stats?.modelCooldowns).toBeUndefined();

      // Profile should be in cooldown for all models
      expect(isProfileInCooldown(store, "google:default")).toBe(true);
      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
