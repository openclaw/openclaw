import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  clearAuthProfileCooldown,
} from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";

function makeStore(usageStats: AuthProfileStore["usageStats"] = {}): AuthProfileStore {
  return {
    version: AUTH_STORE_VERSION,
    profiles: {
      "google:test@example.com": {
        type: "oauth",
        provider: "google",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 3600000,
      },
    },
    usageStats,
  };
}

async function writeStore(agentDir: string, store: AuthProfileStore): Promise<void> {
  await fs.writeFile(path.join(agentDir, "auth-profiles.json"), JSON.stringify(store));
}

async function readStore(agentDir: string): Promise<AuthProfileStore> {
  const content = await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf-8");
  return JSON.parse(content) as AuthProfileStore;
}

describe("per-model cooldown tracking", () => {
  describe("isProfileInCooldown", () => {
    it("returns false when no cooldown is set", () => {
      const store = makeStore();
      expect(isProfileInCooldown(store, "google:test@example.com")).toBe(false);
      expect(isProfileInCooldown(store, "google:test@example.com", "model-a")).toBe(false);
    });

    it("respects provider-level cooldown when no modelId provided", () => {
      const store = makeStore({
        "google:test@example.com": {
          cooldownUntil: Date.now() + 60000,
        },
      });
      expect(isProfileInCooldown(store, "google:test@example.com")).toBe(true);
    });

    it("respects model-specific cooldown when modelId provided", () => {
      const store = makeStore({
        "google:test@example.com": {
          modelCooldowns: {
            "model-a": { cooldownUntil: Date.now() + 60000, errorCount: 1 },
          },
        },
      });
      // Model A should be in cooldown
      expect(isProfileInCooldown(store, "google:test@example.com", "model-a")).toBe(true);
      // Model B should NOT be in cooldown (different model)
      expect(isProfileInCooldown(store, "google:test@example.com", "model-b")).toBe(false);
    });

    it("blocks all models when provider-level cooldown is set (auth failure)", () => {
      const store = makeStore({
        "google:test@example.com": {
          cooldownUntil: Date.now() + 60000, // Provider-level cooldown
        },
      });
      // All models should be blocked
      expect(isProfileInCooldown(store, "google:test@example.com", "model-a")).toBe(true);
      expect(isProfileInCooldown(store, "google:test@example.com", "model-b")).toBe(true);
    });

    it("blocks all models when disabledUntil is set (billing failure)", () => {
      const store = makeStore({
        "google:test@example.com": {
          disabledUntil: Date.now() + 60000,
          disabledReason: "billing",
        },
      });
      expect(isProfileInCooldown(store, "google:test@example.com", "model-a")).toBe(true);
      expect(isProfileInCooldown(store, "google:test@example.com", "model-b")).toBe(true);
    });

    it("allows uncooled model even if another model is in cooldown", () => {
      const store = makeStore({
        "google:test@example.com": {
          modelCooldowns: {
            "model-a": { cooldownUntil: Date.now() + 60000, errorCount: 1 },
          },
        },
      });
      // Model A is in cooldown
      expect(isProfileInCooldown(store, "google:test@example.com", "model-a")).toBe(true);
      // Model B should be allowed
      expect(isProfileInCooldown(store, "google:test@example.com", "model-b")).toBe(false);
      // Provider-level check (no modelId) uses legacy behavior
      expect(isProfileInCooldown(store, "google:test@example.com")).toBe(false);
    });

    it("returns false when cooldown has expired", () => {
      const store = makeStore({
        "google:test@example.com": {
          modelCooldowns: {
            "model-a": { cooldownUntil: Date.now() - 1000, errorCount: 1 }, // Expired
          },
        },
      });
      expect(isProfileInCooldown(store, "google:test@example.com", "model-a")).toBe(false);
    });
  });

  describe("markAuthProfileFailure with modelId", () => {
    let agentDir: string;

    beforeEach(async () => {
      agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    });

    afterEach(async () => {
      await fs.rm(agentDir, { recursive: true, force: true });
    });

    it("sets model-specific cooldown for rate_limit errors", async () => {
      const store = makeStore();
      await writeStore(agentDir, store);

      await markAuthProfileFailure({
        store,
        profileId: "google:test@example.com",
        reason: "rate_limit",
        modelId: "model-a",
        agentDir,
      });

      const saved = await readStore(agentDir);
      const stats = saved.usageStats?.["google:test@example.com"];
      expect(stats?.modelCooldowns?.["model-a"]).toBeDefined();
      expect(stats?.modelCooldowns?.["model-a"]?.cooldownUntil).toBeGreaterThan(Date.now());
      // Provider-level cooldown should NOT be set
      expect(stats?.cooldownUntil).toBeUndefined();
    });

    it("sets provider-level cooldown for auth errors even with modelId", async () => {
      const store = makeStore();
      await writeStore(agentDir, store);

      await markAuthProfileFailure({
        store,
        profileId: "google:test@example.com",
        reason: "auth",
        modelId: "model-a",
        agentDir,
      });

      const saved = await readStore(agentDir);
      const stats = saved.usageStats?.["google:test@example.com"];
      // Provider-level cooldown should be set for auth errors
      expect(stats?.cooldownUntil).toBeGreaterThan(Date.now());
    });

    it("sets provider-level cooldown for billing errors", async () => {
      const store = makeStore();
      await writeStore(agentDir, store);

      await markAuthProfileFailure({
        store,
        profileId: "google:test@example.com",
        reason: "billing",
        modelId: "model-a",
        agentDir,
      });

      const saved = await readStore(agentDir);
      const stats = saved.usageStats?.["google:test@example.com"];
      // Billing errors use disabledUntil
      expect(stats?.disabledUntil).toBeGreaterThan(Date.now());
    });

    it("tracks multiple models independently", async () => {
      const store = makeStore();
      await writeStore(agentDir, store);

      await markAuthProfileFailure({
        store,
        profileId: "google:test@example.com",
        reason: "rate_limit",
        modelId: "model-a",
        agentDir,
      });

      await markAuthProfileFailure({
        store,
        profileId: "google:test@example.com",
        reason: "rate_limit",
        modelId: "model-b",
        agentDir,
      });

      const saved = await readStore(agentDir);
      const stats = saved.usageStats?.["google:test@example.com"];
      expect(stats?.modelCooldowns?.["model-a"]).toBeDefined();
      expect(stats?.modelCooldowns?.["model-b"]).toBeDefined();
    });
  });

  describe("markAuthProfileUsed with modelId", () => {
    let agentDir: string;

    beforeEach(async () => {
      agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    });

    afterEach(async () => {
      await fs.rm(agentDir, { recursive: true, force: true });
    });

    it("clears model cooldown and provider cooldown on successful use", async () => {
      const store = makeStore({
        "google:test@example.com": {
          cooldownUntil: Date.now() + 60000,
          modelCooldowns: {
            "model-a": { cooldownUntil: Date.now() + 60000, errorCount: 1 },
            "model-b": { cooldownUntil: Date.now() + 60000, errorCount: 1 },
          },
        },
      });
      await writeStore(agentDir, store);

      await markAuthProfileUsed({
        store,
        profileId: "google:test@example.com",
        modelId: "model-a",
        agentDir,
      });

      const saved = await readStore(agentDir);
      const stats = saved.usageStats?.["google:test@example.com"];
      // Model A cooldown should be cleared
      expect(stats?.modelCooldowns?.["model-a"]).toBeUndefined();
      // Model B cooldown should remain
      expect(stats?.modelCooldowns?.["model-b"]).toBeDefined();
      // Provider-level cooldown should also be cleared (successful use proves auth works)
      expect(stats?.cooldownUntil).toBeUndefined();
    });

    it("clears all cooldowns when no modelId provided", async () => {
      const store = makeStore({
        "google:test@example.com": {
          cooldownUntil: Date.now() + 60000,
          modelCooldowns: {
            "model-a": { cooldownUntil: Date.now() + 60000, errorCount: 1 },
          },
        },
      });
      await writeStore(agentDir, store);

      await markAuthProfileUsed({
        store,
        profileId: "google:test@example.com",
        agentDir,
      });

      const saved = await readStore(agentDir);
      const stats = saved.usageStats?.["google:test@example.com"];
      expect(stats?.cooldownUntil).toBeUndefined();
      expect(stats?.modelCooldowns).toBeUndefined();
    });
  });

  describe("clearAuthProfileCooldown", () => {
    let agentDir: string;

    beforeEach(async () => {
      agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    });

    afterEach(async () => {
      await fs.rm(agentDir, { recursive: true, force: true });
    });

    it("clears both provider-level and model cooldowns", async () => {
      const store = makeStore({
        "google:test@example.com": {
          cooldownUntil: Date.now() + 60000,
          errorCount: 5,
          modelCooldowns: {
            "model-a": { cooldownUntil: Date.now() + 60000, errorCount: 1 },
          },
        },
      });
      await writeStore(agentDir, store);

      await clearAuthProfileCooldown({
        store,
        profileId: "google:test@example.com",
        agentDir,
      });

      const saved = await readStore(agentDir);
      const stats = saved.usageStats?.["google:test@example.com"];
      expect(stats?.cooldownUntil).toBeUndefined();
      expect(stats?.modelCooldowns).toBeUndefined();
      expect(stats?.errorCount).toBe(0);
    });
  });
});
