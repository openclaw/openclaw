import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

async function writeAuthStore(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
    },
    order: {
      zai: ["zai:work"],
    },
  };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf-8");
}

describe("resolveSessionAuthProfileOverride", () => {
  it("keeps user override when provider alias differs", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir);

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "z.ai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("zai:work");
      expect(sessionEntry.authProfileOverride).toBe("zai:work");
    });
  });

  it("re-selects higher-priority profile when it exits cooldown", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const authPath = path.join(agentDir, "auth-profiles.json");
      const now = Date.now();
      await fs.writeFile(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "anth:oauth": { type: "token", provider: "anthropic", token: "tok-oauth" },
            "anth:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
          },
          order: { anthropic: ["anth:oauth", "anth:default"] },
          usageStats: {
            "anth:oauth": {
              lastUsed: now - 120_000,
              cooldownUntil: now - 1_000,
            },
            "anth:default": { lastUsed: now - 60_000 },
          },
        }),
        "utf-8",
      );

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: now - 30_000,
        authProfileOverride: "anth:default",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "anthropic",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("anth:oauth");
    });
  });

  it("keeps intentional new-session rotation to the next healthy profile", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const authPath = path.join(agentDir, "auth-profiles.json");
      await fs.writeFile(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "anth:oauth": { type: "token", provider: "anthropic", token: "tok-oauth" },
            "anth:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
          },
          order: { anthropic: ["anth:oauth", "anth:default"] },
          usageStats: {
            "anth:oauth": { lastUsed: Date.now() - 120_000 },
            "anth:default": { lastUsed: Date.now() - 60_000 },
          },
        }),
        "utf-8",
      );

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now() - 30_000,
        authProfileOverride: "anth:oauth",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      };
      const sessionStore = { "agent:main:main": sessionEntry };
      const current = sessionEntry.authProfileOverride;

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "anthropic",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).not.toBe(current);
      expect(resolved).toBe("anth:default");
    });
  });
  it("stays on current profile when higher-priority profiles are still in cooldown", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const authPath = path.join(agentDir, "auth-profiles.json");
      const now = Date.now();
      await fs.writeFile(
        authPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "anth:oauth": { type: "token", provider: "anthropic", token: "tok-oauth" },
            "anth:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
          },
          order: { anthropic: ["anth:oauth", "anth:default"] },
          usageStats: {
            "anth:oauth": {
              lastUsed: now - 10_000,
              consecutiveErrors: 3,
              cooldownUntil: now + 300_000,
            },
            "anth:default": { lastUsed: now - 5_000 },
          },
        }),
        "utf-8",
      );

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: now - 5_000,
        authProfileOverride: "anth:default",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "anthropic",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("anth:default");
    });
  });
});
