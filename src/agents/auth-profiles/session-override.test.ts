import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

async function writeAuthStore(agentDir: string, payload?: Record<string, unknown>) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const defaultPayload = {
    version: 1,
    profiles: {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
    },
    order: {
      zai: ["zai:work"],
    },
  };
  await fs.writeFile(authPath, JSON.stringify(payload ?? defaultPayload), "utf-8");
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

  it("treats legacy source-less overrides as auto when provider has multiple profiles", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-default",
          },
          "openai-codex:acct1": {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-acct1",
          },
        },
        order: {
          "openai-codex": ["openai-codex:default", "openai-codex:acct1"],
        },
        usageStats: {
          "openai-codex:default": {
            totalAttempts: 1,
            successCount: 0,
            failureCount: 1,
            cooldownUntil: Date.now() + 60_000,
          },
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s2",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:default",
      };
      const sessionStore = { "agent:main:discord:channel:1": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:discord:channel:1",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("openai-codex:acct1");
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:acct1");
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });
});
