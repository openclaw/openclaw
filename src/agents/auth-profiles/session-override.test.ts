import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

type AuthStoreFixture = {
  version?: number;
  profiles: Record<string, { type: string; provider: string; key: string }>;
  order: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, { cooldownUntil?: number; disabledUntil?: number }>;
};

async function writeAuthStore(agentDir: string, fixture?: Partial<AuthStoreFixture>) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload: AuthStoreFixture = {
    version: 1,
    profiles: {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-work" },
      "zai:backup": { type: "api_key", provider: "zai", key: "sk-backup" },
    },
    order: {
      zai: ["zai:work", "zai:backup"],
    },
    ...fixture,
  };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf-8");
}

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("resolveSessionAuthProfileOverride", () => {
  it("keeps user override when provider alias differs", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir);

      const sessionEntry = createSessionEntry({
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "user",
      });
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

  it("prefers lastGood when it is selectable", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, { lastGood: { zai: "zai:backup" } });

      const sessionEntry = createSessionEntry();
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).toBe("zai:backup");
    });
  });

  it("falls back to first available profile when lastGood is missing", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir);

      const sessionEntry = createSessionEntry();
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).toBe("zai:work");
    });
  });

  it("ignores lastGood when it is not in provider order", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        lastGood: { zai: "zai:orphan" },
        profiles: {
          "zai:work": { type: "api_key", provider: "zai", key: "sk-work" },
          "zai:backup": { type: "api_key", provider: "zai", key: "sk-backup" },
          "zai:orphan": { type: "api_key", provider: "zai", key: "sk-orphan" },
        },
      });

      const sessionEntry = createSessionEntry();
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).toBe("zai:work");
    });
  });

  it("ignores lastGood when it is in cooldown", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        lastGood: { zai: "zai:work" },
        profiles: {
          "zai:work": { type: "api_key", provider: "zai", key: "sk-work" },
          "zai:backup": { type: "api_key", provider: "zai", key: "sk-backup" },
        },
        usageStats: {
          "zai:work": { cooldownUntil: Date.now() + 60_000 },
        },
      });

      const sessionEntry = createSessionEntry();
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).toBe("zai:backup");
    });
  });

  it("preserves existing fallback when all profiles are unavailable", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const cooldownUntil = Date.now() + 60_000;
      await writeAuthStore(agentDir, {
        lastGood: { zai: "zai:backup" },
        profiles: {
          "zai:work": { type: "api_key", provider: "zai", key: "sk-work" },
          "zai:backup": { type: "api_key", provider: "zai", key: "sk-backup" },
        },
        usageStats: {
          "zai:work": { cooldownUntil },
          "zai:backup": { cooldownUntil },
        },
      });

      const sessionEntry = createSessionEntry();
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).toBe("zai:work");
    });
  });

  it("accepts legacy alias keys when reading lastGood", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, { lastGood: { "z.ai": "zai:backup" } });

      const sessionEntry = createSessionEntry();
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "zai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).toBe("zai:backup");
    });
  });
});
