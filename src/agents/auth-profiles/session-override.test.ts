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

  it("canonicalizes legacy :default auto override to email profile when available", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            email: "josh@example.com",
            access: "access-token-default",
          },
          "openai-codex:josh@example.com": {
            type: "oauth",
            provider: "openai-codex",
            email: "josh@example.com",
            access: "access-token-email",
          },
        },
        order: {
          "openai-codex": ["openai-codex:josh@example.com", "openai-codex:default"],
        },
      });

      const cfg = {
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              mode: "oauth",
              email: "josh@example.com",
            },
          },
        },
      } as OpenClawConfig;

      const sessionEntry: SessionEntry = {
        sessionId: "s2",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
      };
      const sessionStore = { "agent:main:telegram:direct:8578467390": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:telegram:direct:8578467390",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("openai-codex:josh@example.com");
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:josh@example.com");
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });

  it("prefers non-default oauth alias even when alias email metadata is missing", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            email: "josh@example.com",
            accountId: "acct_123",
            access: "access-token-default",
          },
          "openai-codex:josh%40example.com": {
            type: "oauth",
            provider: "openai-codex",
            accountId: "acct_123",
            access: "access-token-email",
          },
        },
        order: {
          "openai-codex": ["openai-codex:default", "openai-codex:josh%40example.com"],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s3",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
      };
      const sessionStore = { "agent:main:telegram:direct:8578467390": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:telegram:direct:8578467390",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("openai-codex:josh%40example.com");
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:josh%40example.com");
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });
});
