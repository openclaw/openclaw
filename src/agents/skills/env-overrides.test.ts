import type { Skill } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";
import { applySkillEnvOverrides, applySkillEnvOverridesFromSnapshot } from "./env-overrides.js";

/**
 * VULN-160: Block dangerous environment variables from skill config
 *
 * Tests that dangerous environment variables that could enable code injection
 * (NODE_OPTIONS, LD_PRELOAD, DYLD_INSERT_LIBRARIES, etc.) are blocked from
 * being set via skill config env entries.
 */
describe("VULN-160: skill env override blocking", () => {
  // Track env vars we modify for cleanup, storing previous values
  const modifiedEnvVars = new Map<string, string | undefined>();

  // Helper to capture previous env var values before tests modify them
  function captureEnvVars(...keys: string[]) {
    for (const key of keys) {
      if (!modifiedEnvVars.has(key)) {
        modifiedEnvVars.set(key, process.env[key]);
      }
    }
  }

  beforeEach(() => {
    modifiedEnvVars.clear();
  });

  afterEach(() => {
    // Restore env vars to their previous values (or delete if undefined)
    for (const [key, prevValue] of modifiedEnvVars) {
      if (prevValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prevValue;
      }
    }
  });

  function createMockSkill(name: string): Skill {
    return {
      name,
      source: "test",
      content: "# Test skill",
    };
  }

  function createSkillEntry(name: string, primaryEnv?: string): SkillEntry {
    return {
      skill: createMockSkill(name),
      frontmatter: { name },
      metadata: primaryEnv ? { primaryEnv } : undefined,
    };
  }

  function createConfig(
    skillsConfig: Record<string, { env?: Record<string, string>; apiKey?: string }>,
  ): OpenClawConfig {
    return {
      skills: {
        entries: skillsConfig,
      },
    } as OpenClawConfig;
  }

  describe("applySkillEnvOverrides", () => {
    it("blocks NODE_OPTIONS from skill env config", () => {
      const skills: SkillEntry[] = [createSkillEntry("test-skill")];
      const config = createConfig({
        "test-skill": {
          env: {
            NODE_OPTIONS: "--require=/tmp/malicious.js",
            SAFE_VAR: "safe-value",
          },
        },
      });

      captureEnvVars("NODE_OPTIONS", "SAFE_VAR");

      const cleanup = applySkillEnvOverrides({ skills, config });

      // NODE_OPTIONS should be blocked
      expect(process.env.NODE_OPTIONS).toBeUndefined();
      // Safe vars should still work
      expect(process.env.SAFE_VAR).toBe("safe-value");

      cleanup();
    });

    it("blocks LD_PRELOAD from skill env config", () => {
      const skills: SkillEntry[] = [createSkillEntry("test-skill")];
      const config = createConfig({
        "test-skill": {
          env: {
            LD_PRELOAD: "/tmp/malicious.so",
          },
        },
      });

      captureEnvVars("LD_PRELOAD");

      const cleanup = applySkillEnvOverrides({ skills, config });

      expect(process.env.LD_PRELOAD).toBeUndefined();

      cleanup();
    });

    it("blocks DYLD_INSERT_LIBRARIES from skill env config", () => {
      const skills: SkillEntry[] = [createSkillEntry("test-skill")];
      const config = createConfig({
        "test-skill": {
          env: {
            DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
          },
        },
      });

      captureEnvVars("DYLD_INSERT_LIBRARIES");

      const cleanup = applySkillEnvOverrides({ skills, config });

      expect(process.env.DYLD_INSERT_LIBRARIES).toBeUndefined();

      cleanup();
    });

    it("blocks PYTHONPATH from skill env config", () => {
      const skills: SkillEntry[] = [createSkillEntry("test-skill")];
      const config = createConfig({
        "test-skill": {
          env: {
            PYTHONPATH: "/tmp/malicious-python",
          },
        },
      });

      captureEnvVars("PYTHONPATH");

      const cleanup = applySkillEnvOverrides({ skills, config });

      expect(process.env.PYTHONPATH).toBeUndefined();

      cleanup();
    });

    it("blocks BASH_ENV from skill env config", () => {
      const skills: SkillEntry[] = [createSkillEntry("test-skill")];
      const config = createConfig({
        "test-skill": {
          env: {
            BASH_ENV: "/tmp/evil.sh",
          },
        },
      });

      captureEnvVars("BASH_ENV");

      const cleanup = applySkillEnvOverrides({ skills, config });

      expect(process.env.BASH_ENV).toBeUndefined();

      cleanup();
    });

    it("blocks pattern-based dangerous vars like LD_LIBRARY_PATH", () => {
      const skills: SkillEntry[] = [createSkillEntry("test-skill")];
      const config = createConfig({
        "test-skill": {
          env: {
            LD_LIBRARY_PATH: "/tmp/lib",
            DYLD_FRAMEWORK_PATH: "/tmp/frameworks",
          },
        },
      });

      captureEnvVars("LD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH");

      const cleanup = applySkillEnvOverrides({ skills, config });

      expect(process.env.LD_LIBRARY_PATH).toBeUndefined();
      expect(process.env.DYLD_FRAMEWORK_PATH).toBeUndefined();

      cleanup();
    });

    it("allows safe API key variables", () => {
      const skills: SkillEntry[] = [createSkillEntry("test-skill")];
      const config = createConfig({
        "test-skill": {
          env: {
            OPENAI_API_KEY: "sk-test",
            ANTHROPIC_API_KEY: "sk-ant-test",
            MY_CUSTOM_VAR: "custom-value",
          },
        },
      });

      captureEnvVars("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MY_CUSTOM_VAR");

      const cleanup = applySkillEnvOverrides({ skills, config });

      expect(process.env.OPENAI_API_KEY).toBe("sk-test");
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
      expect(process.env.MY_CUSTOM_VAR).toBe("custom-value");

      cleanup();
    });

    it("allows primaryEnv API key via apiKey config", () => {
      const skills: SkillEntry[] = [createSkillEntry("test-skill", "TEST_API_KEY")];
      const config = createConfig({
        "test-skill": {
          apiKey: "test-api-key-value",
        },
      });

      captureEnvVars("TEST_API_KEY");

      const cleanup = applySkillEnvOverrides({ skills, config });

      expect(process.env.TEST_API_KEY).toBe("test-api-key-value");

      cleanup();
    });

    it("cleanup function restores original env state", () => {
      const originalValue = "original-value";
      process.env.TEST_RESTORE_VAR = originalValue;
      captureEnvVars("TEST_RESTORE_VAR");

      const skills: SkillEntry[] = [createSkillEntry("test-skill")];
      const config = createConfig({
        "test-skill": {
          env: {
            NEW_VAR: "new-value",
          },
        },
      });

      captureEnvVars("NEW_VAR");

      const cleanup = applySkillEnvOverrides({ skills, config });

      expect(process.env.NEW_VAR).toBe("new-value");

      cleanup();

      expect(process.env.NEW_VAR).toBeUndefined();
      expect(process.env.TEST_RESTORE_VAR).toBe(originalValue);
    });
  });

  describe("applySkillEnvOverridesFromSnapshot", () => {
    it("blocks NODE_OPTIONS from snapshot skill config", () => {
      const snapshot: SkillSnapshot = {
        prompt: "test prompt",
        skills: [{ name: "test-skill" }],
      };
      const config = createConfig({
        "test-skill": {
          env: {
            NODE_OPTIONS: "--require=/tmp/malicious.js",
            SAFE_VAR: "safe-value",
          },
        },
      });

      captureEnvVars("NODE_OPTIONS", "SAFE_VAR");

      const cleanup = applySkillEnvOverridesFromSnapshot({ snapshot, config });

      // NODE_OPTIONS should be blocked
      expect(process.env.NODE_OPTIONS).toBeUndefined();
      // Safe vars should still work
      expect(process.env.SAFE_VAR).toBe("safe-value");

      cleanup();
    });

    it("blocks LD_PRELOAD from snapshot skill config", () => {
      const snapshot: SkillSnapshot = {
        prompt: "test prompt",
        skills: [{ name: "test-skill" }],
      };
      const config = createConfig({
        "test-skill": {
          env: {
            LD_PRELOAD: "/tmp/malicious.so",
          },
        },
      });

      captureEnvVars("LD_PRELOAD");

      const cleanup = applySkillEnvOverridesFromSnapshot({ snapshot, config });

      expect(process.env.LD_PRELOAD).toBeUndefined();

      cleanup();
    });

    it("allows primaryEnv API key from snapshot via apiKey config", () => {
      const snapshot: SkillSnapshot = {
        prompt: "test prompt",
        skills: [{ name: "test-skill", primaryEnv: "SNAPSHOT_API_KEY" }],
      };
      const config = createConfig({
        "test-skill": {
          apiKey: "snapshot-api-key-value",
        },
      });

      captureEnvVars("SNAPSHOT_API_KEY");

      const cleanup = applySkillEnvOverridesFromSnapshot({ snapshot, config });

      expect(process.env.SNAPSHOT_API_KEY).toBe("snapshot-api-key-value");

      cleanup();
    });

    it("returns no-op cleanup when snapshot is undefined", () => {
      const cleanup = applySkillEnvOverridesFromSnapshot({ snapshot: undefined });

      // Should not throw and cleanup should be callable
      expect(typeof cleanup).toBe("function");
      cleanup();
    });
  });
});
