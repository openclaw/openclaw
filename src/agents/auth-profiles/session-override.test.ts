import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

async function writeAuthStore(agentDir: string, payload?: unknown) {
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

  it("prefers lastGood on a new session", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        version: 1,
        profiles: {
          "openai-codex:default": { type: "oauth", provider: "openai-codex", access: "a" },
          "openai-codex:account2": { type: "oauth", provider: "openai-codex", access: "b" },
        },
        lastGood: {
          "openai-codex": "openai-codex:account2",
        },
      });

      const cfg = {
        auth: {
          order: {
            "openai-codex": ["openai-codex:default", "openai-codex:account2"],
          },
        },
      } as OpenClawConfig;

      const sessionEntry: SessionEntry = {
        sessionId: "s2",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:designer:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:designer:main",
        storePath: undefined,
        isNewSession: true,
      });

      expect(resolved).toBe("openai-codex:account2");
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:account2");
    });
  });

  it("updates stale auto override to lastGood on existing session", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        version: 1,
        profiles: {
          "openai-codex:default": { type: "oauth", provider: "openai-codex", access: "a" },
          "openai-codex:account2": { type: "oauth", provider: "openai-codex", access: "b" },
        },
        lastGood: {
          "openai-codex": "openai-codex:account2",
        },
      });

      const cfg = {
        auth: {
          order: {
            "openai-codex": ["openai-codex:default", "openai-codex:account2"],
          },
        },
      } as OpenClawConfig;

      const sessionEntry: SessionEntry = {
        sessionId: "s3",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
        compactionCount: 0,
      };
      const sessionStore = { "agent:designer:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:designer:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("openai-codex:account2");
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:account2");
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });
});
