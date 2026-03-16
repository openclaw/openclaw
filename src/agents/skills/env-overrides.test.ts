import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySkillEnvOverrides } from "./env-overrides.js";
import type { SkillEntry } from "./types.js";
import type { OpenClawConfig } from "../../config/config.js";

describe("skills/env-overrides", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear any env vars set by previous tests
    for (const key of Object.keys(process.env)) {
      if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  describe("user-configured env vars in skills.entries.<skill>.env", () => {
    it("should allow API_KEY patterns when explicitly configured by user", () => {
      const skillKey = "tavily";
      const envKey = "TAVILY_API_KEY";
      const envValue = "tvly-dev-test-key";

      const skillEntry: SkillEntry = {
        skill: {
          name: skillKey,
          version: "1.0.0",
          description: "Test skill",
        },
        metadata: {},
        location: "/test/skill",
      };

      const config: OpenClawConfig = {
        skills: {
          entries: {
            [skillKey]: {
              enabled: true,
              env: {
                [envKey]: envValue,
              },
            },
          },
        },
      };

      const revert = applySkillEnvOverrides({
        skills: [skillEntry],
        config,
      });

      expect(process.env[envKey]).toBe(envValue);

      revert();

      expect(process.env[envKey]).toBeUndefined();
    });

    it("should allow TOKEN patterns when explicitly configured by user", () => {
      const skillKey = "test-service";
      const envKey = "TEST_SERVICE_TOKEN";
      const envValue = "test-token-value";

      const skillEntry: SkillEntry = {
        skill: {
          name: skillKey,
          version: "1.0.0",
          description: "Test skill",
        },
        metadata: {},
        location: "/test/skill",
      };

      const config: OpenClawConfig = {
        skills: {
          entries: {
            [skillKey]: {
              enabled: true,
              env: {
                [envKey]: envValue,
              },
            },
          },
        },
      };

      const revert = applySkillEnvOverrides({
        skills: [skillEntry],
        config,
      });

      expect(process.env[envKey]).toBe(envValue);

      revert();

      expect(process.env[envKey]).toBeUndefined();
    });

    it("should block dangerous host env vars even when configured by user", () => {
      const skillKey = "test-skill";
      const envKey = "OPENSSL_CONF";
      const envValue = "/malicious/path";

      const skillEntry: SkillEntry = {
        skill: {
          name: skillKey,
          version: "1.0.0",
          description: "Test skill",
        },
        metadata: {},
        location: "/test/skill",
      };

      const config: OpenClawConfig = {
        skills: {
          entries: {
            [skillKey]: {
              enabled: true,
              env: {
                [envKey]: envValue,
              },
            },
          },
        },
      };

      const revert = applySkillEnvOverrides({
        skills: [skillEntry],
        config,
      });

      expect(process.env[envKey]).toBeUndefined();

      revert();
    });

    it("should block env vars with null bytes", () => {
      const skillKey = "test-skill";
      const envKey = "TEST_API_KEY";
      const envValue = "value\0with-null";

      const skillEntry: SkillEntry = {
        skill: {
          name: skillKey,
          version: "1.0.0",
          description: "Test skill",
        },
        metadata: {},
        location: "/test/skill",
      };

      const config: OpenClawConfig = {
        skills: {
          entries: {
            [skillKey]: {
              enabled: true,
              env: {
                [envKey]: envValue,
              },
            },
          },
        },
      };

      const revert = applySkillEnvOverrides({
        skills: [skillEntry],
        config,
      });

      expect(process.env[envKey]).toBeUndefined();

      revert();
    });

    it("should respect primaryEnv metadata when injecting apiKey", () => {
      const skillKey = "tavily";
      const envKey = "TAVILY_API_KEY";
      const apiKey = "tvly-dev-test-key";

      const skillEntry: SkillEntry = {
        skill: {
          name: skillKey,
          version: "1.0.0",
          description: "Test skill",
        },
        metadata: {
          primaryEnv: envKey,
        },
        location: "/test/skill",
      };

      const config: OpenClawConfig = {
        skills: {
          entries: {
            [skillKey]: {
              enabled: true,
              apiKey,
            },
          },
        },
      };

      const revert = applySkillEnvOverrides({
        skills: [skillEntry],
        config,
      });

      expect(process.env[envKey]).toBe(apiKey);

      revert();

      expect(process.env[envKey]).toBeUndefined();
    });

    it("should not override externally managed env vars", () => {
      const skillKey = "tavily";
      const envKey = "TAVILY_API_KEY";
      const externalValue = "external-key";
      const configValue = "config-key";

      // Set external env var
      process.env[envKey] = externalValue;

      const skillEntry: SkillEntry = {
        skill: {
          name: skillKey,
          version: "1.0.0",
          description: "Test skill",
        },
        metadata: {},
        location: "/test/skill",
      };

      const config: OpenClawConfig = {
        skills: {
          entries: {
            [skillKey]: {
              enabled: true,
              env: {
                [envKey]: configValue,
              },
            },
          },
        },
      };

      const revert = applySkillEnvOverrides({
        skills: [skillEntry],
        config,
      });

      // Should keep external value, not override with config
      expect(process.env[envKey]).toBe(externalValue);

      revert();

      expect(process.env[envKey]).toBe(externalValue);
    });
  });
});
