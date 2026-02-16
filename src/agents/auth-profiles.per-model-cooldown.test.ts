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

function createTestStore(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-test",
        },
        "google:default": {
          type: "api_key",
          provider: "google",
          key: "test-key",
        },
      },
    }),
  );
  return ensureAuthProfileStore(agentDir);
}

describe("per-model rate-limit cooldown", () => {
  it("rate_limit on model A does NOT block model B on same profile", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cd-"));
    try {
      const store = createTestStore(agentDir);

      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        modelId: "claude-opus-4-5",
        agentDir,
      });

      // Opus should be in cooldown
      expect(isProfileInCooldown(store, "anthropic:default", "claude-opus-4-5")).toBe(true);
      // Sonnet should NOT be in cooldown
      expect(isProfileInCooldown(store, "anthropic:default", "claude-sonnet-4-5")).toBe(false);
      // Profile-level should NOT be in cooldown (failure was model-scoped)
      expect(isProfileInCooldown(store, "anthropic:default")).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("billing failure blocks ALL models on the profile", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cd-"));
    try {
      const store = createTestStore(agentDir);

      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "billing",
        modelId: "claude-opus-4-5",
        agentDir,
      });

      expect(isProfileInCooldown(store, "anthropic:default", "claude-opus-4-5")).toBe(true);
      expect(isProfileInCooldown(store, "anthropic:default", "claude-sonnet-4-5")).toBe(true);
      expect(isProfileInCooldown(store, "anthropic:default")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("auth failure blocks ALL models on the profile", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cd-"));
    try {
      const store = createTestStore(agentDir);

      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "auth",
        modelId: "claude-opus-4-5",
        agentDir,
      });

      expect(isProfileInCooldown(store, "anthropic:default", "claude-opus-4-5")).toBe(true);
      expect(isProfileInCooldown(store, "anthropic:default", "claude-sonnet-4-5")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("backward compat: no modelId = profile-level cooldown", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cd-"));
    try {
      const store = createTestStore(agentDir);

      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        agentDir,
      });

      // Profile-level cooldown → blocks everything
      expect(isProfileInCooldown(store, "anthropic:default")).toBe(true);
      expect(isProfileInCooldown(store, "anthropic:default", "claude-opus-4-5")).toBe(true);
      expect(isProfileInCooldown(store, "anthropic:default", "claude-sonnet-4-5")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("successful use clears model-specific cooldown", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cd-"));
    try {
      const store = createTestStore(agentDir);

      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        modelId: "claude-opus-4-5",
        agentDir,
      });
      expect(isProfileInCooldown(store, "anthropic:default", "claude-opus-4-5")).toBe(true);

      await markAuthProfileUsed({
        store,
        profileId: "anthropic:default",
        modelId: "claude-opus-4-5",
        agentDir,
      });
      expect(isProfileInCooldown(store, "anthropic:default", "claude-opus-4-5")).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("profile-level cooldown takes precedence over model-level availability", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cd-"));
    try {
      const store = createTestStore(agentDir);

      // Model-scoped rate limit on Opus
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        modelId: "claude-opus-4-5",
        agentDir,
      });
      expect(isProfileInCooldown(store, "anthropic:default", "claude-sonnet-4-5")).toBe(false);

      // Now billing failure → profile-level block
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "billing",
        agentDir,
      });
      // Sonnet now blocked too (profile-level)
      expect(isProfileInCooldown(store, "anthropic:default", "claude-sonnet-4-5")).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("works for Google models (provider-agnostic)", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cd-"));
    try {
      const store = createTestStore(agentDir);

      await markAuthProfileFailure({
        store,
        profileId: "google:default",
        reason: "rate_limit",
        modelId: "gemini-3-flash-preview",
        agentDir,
      });

      expect(isProfileInCooldown(store, "google:default", "gemini-3-flash-preview")).toBe(true);
      expect(isProfileInCooldown(store, "google:default", "gemini-3-pro-preview")).toBe(false);
      expect(isProfileInCooldown(store, "google:default", "gemini-2.5-flash-lite")).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("model cooldown uses exponential backoff", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cd-"));
    try {
      const store = createTestStore(agentDir);
      const now = Date.now();

      // First failure → 1 min
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        modelId: "claude-opus-4-5",
        agentDir,
      });

      const stats1 = store.usageStats?.["anthropic:default"]?.modelCooldowns?.["claude-opus-4-5"];
      expect(stats1).toBeDefined();
      expect(stats1!.errorCount).toBe(1);
      const cooldown1Ms = stats1!.cooldownUntil! - now;
      // First backoff: ~60s (1 min)
      expect(cooldown1Ms).toBeGreaterThan(50_000);
      expect(cooldown1Ms).toBeLessThan(70_000);

      // Second failure → 5 min
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        modelId: "claude-opus-4-5",
        agentDir,
      });

      const stats2 = store.usageStats?.["anthropic:default"]?.modelCooldowns?.["claude-opus-4-5"];
      expect(stats2!.errorCount).toBe(2);
      const cooldown2Ms = stats2!.cooldownUntil! - now;
      // Second backoff: ~300s (5 min)
      expect(cooldown2Ms).toBeGreaterThan(250_000);
      expect(cooldown2Ms).toBeLessThan(350_000);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("multiple models can have independent cooldowns on same profile", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-cd-"));
    try {
      const store = createTestStore(agentDir);

      // Rate-limit both Opus and Haiku
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        modelId: "claude-opus-4-5",
        agentDir,
      });
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        modelId: "claude-haiku-4-5",
        agentDir,
      });

      // Both should be in cooldown
      expect(isProfileInCooldown(store, "anthropic:default", "claude-opus-4-5")).toBe(true);
      expect(isProfileInCooldown(store, "anthropic:default", "claude-haiku-4-5")).toBe(true);
      // Sonnet should still be free
      expect(isProfileInCooldown(store, "anthropic:default", "claude-sonnet-4-5")).toBe(false);
      // Profile-level should NOT be in cooldown
      expect(isProfileInCooldown(store, "anthropic:default")).toBe(false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
