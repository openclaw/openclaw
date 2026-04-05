import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

async function writeAuthStore(
  agentDir: string,
  params: {
    profiles: Record<string, { type: string; provider: string; key: string }>;
    order: Record<string, string[]>;
  },
) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = { version: 1, profiles: params.profiles, order: params.order };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf-8");
}

describe("resolveSessionAuthProfileOverride", () => {
  it("returns early when no auth sources exist", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openrouter",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBeUndefined();
      await expect(fs.access(path.join(agentDir, "auth-profiles.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("keeps user override when provider alias differs", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
        },
        order: {
          zai: ["zai:work"],
        },
      });

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

  it("keeps a user-selected profile pinned across new sessions", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "openai-codex:chatgpt": {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-chatgpt",
          },
          "openai-codex:default": {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-default",
          },
        },
        order: {
          "openai-codex": ["openai-codex:chatgpt", "openai-codex:default"],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).toBe("openai-codex:default");
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:default");
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
      expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
    });
  });

  it("still rotates auto-selected profiles on new sessions", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "zai:work": { type: "api_key", provider: "zai", key: "sk-work" },
          "zai:backup": { type: "api_key", provider: "zai", key: "sk-backup" },
        },
        order: {
          zai: ["zai:work", "zai:backup"],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "auto",
      };
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
      expect(sessionEntry.authProfileOverride).toBe("zai:backup");
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });
});
