import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  getProfileCooldownRemainingMs,
  getProfileHealthStatus,
  isProfileApproachingCooldown,
} from "./auth-profiles/usage.js";

describe("proactive cooldown detection", () => {
  describe("isProfileApproachingCooldown", () => {
    it("returns false for a profile with no errors", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 0,
          },
        },
      };
      expect(isProfileApproachingCooldown(store, "test-profile")).toBe(false);
    });

    it("returns false for a profile with one error", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 1,
          },
        },
      };
      expect(isProfileApproachingCooldown(store, "test-profile")).toBe(false);
    });

    it("returns true for a profile with error count at threshold", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 2,
          },
        },
      };
      expect(isProfileApproachingCooldown(store, "test-profile")).toBe(true);
    });

    it("returns true for a profile with error count above threshold", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 5,
          },
        },
      };
      expect(isProfileApproachingCooldown(store, "test-profile")).toBe(true);
    });

    it("returns false for a profile already in cooldown", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 3,
            cooldownUntil: Date.now() + 60_000, // 1 minute from now
          },
        },
      };
      expect(isProfileApproachingCooldown(store, "test-profile")).toBe(false);
    });

    it("respects custom threshold", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 1,
          },
        },
      };
      expect(isProfileApproachingCooldown(store, "test-profile", 1)).toBe(true);
      expect(isProfileApproachingCooldown(store, "test-profile", 2)).toBe(false);
    });

    it("returns false for non-existent profile", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {},
        usageStats: {},
      };
      expect(isProfileApproachingCooldown(store, "non-existent")).toBe(false);
    });
  });

  describe("getProfileCooldownRemainingMs", () => {
    it("returns 0 for a profile not in cooldown", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 0,
          },
        },
      };
      expect(getProfileCooldownRemainingMs(store, "test-profile")).toBe(0);
    });

    it("returns remaining time for a profile in cooldown", () => {
      const cooldownEnd = Date.now() + 60_000; // 1 minute from now
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            cooldownUntil: cooldownEnd,
          },
        },
      };
      const remaining = getProfileCooldownRemainingMs(store, "test-profile");
      expect(remaining).toBeGreaterThan(59_000);
      expect(remaining).toBeLessThanOrEqual(60_000);
    });

    it("returns 0 for expired cooldown", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            cooldownUntil: Date.now() - 1000, // 1 second ago
          },
        },
      };
      expect(getProfileCooldownRemainingMs(store, "test-profile")).toBe(0);
    });

    it("returns 0 for non-existent profile", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {},
        usageStats: {},
      };
      expect(getProfileCooldownRemainingMs(store, "non-existent")).toBe(0);
    });
  });

  describe("getProfileHealthStatus", () => {
    it("returns healthy for a profile with no errors", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 0,
          },
        },
      };
      const status = getProfileHealthStatus(store, "test-profile");
      expect(status.status).toBe("healthy");
      expect(status.errorCount).toBe(0);
      expect(status.cooldownRemainingMs).toBe(0);
    });

    it("returns healthy for a profile with one error", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 1,
          },
        },
      };
      const status = getProfileHealthStatus(store, "test-profile");
      expect(status.status).toBe("healthy");
      expect(status.errorCount).toBe(1);
    });

    it("returns warning for a profile approaching cooldown", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 2,
          },
        },
      };
      const status = getProfileHealthStatus(store, "test-profile");
      expect(status.status).toBe("warning");
      expect(status.errorCount).toBe(2);
    });

    it("returns cooldown for a profile in cooldown", () => {
      const cooldownEnd = Date.now() + 60_000;
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 3,
            cooldownUntil: cooldownEnd,
          },
        },
      };
      const status = getProfileHealthStatus(store, "test-profile");
      expect(status.status).toBe("cooldown");
      expect(status.errorCount).toBe(3);
      expect(status.cooldownRemainingMs).toBeGreaterThan(0);
    });

    it("returns disabled for a disabled profile", () => {
      const disabledUntil = Date.now() + 3600_000; // 1 hour from now
      const store: AuthProfileStore = {
        version: 1,
        profiles: { "test-profile": { type: "api_key", provider: "openai", key: "sk-xxx" } },
        usageStats: {
          "test-profile": {
            errorCount: 5,
            disabledUntil,
            disabledReason: "billing",
          },
        },
      };
      const status = getProfileHealthStatus(store, "test-profile");
      expect(status.status).toBe("disabled");
      expect(status.disabledReason).toBe("billing");
    });

    it("returns healthy for non-existent profile", () => {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {},
        usageStats: {},
      };
      const status = getProfileHealthStatus(store, "non-existent");
      expect(status.status).toBe("healthy");
      expect(status.errorCount).toBe(0);
    });
  });
});
