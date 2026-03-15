import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

async function writeAuthStore(
  agentDir: string,
  extra?: {
    usageStats?: Record<string, unknown>;
    profiles?: Record<string, unknown>;
    order?: Record<string, string[]>;
  },
) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: extra?.profiles ?? {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
    },
    order: extra?.order ?? {
      zai: ["zai:work"],
    },
    ...(extra?.usageStats ? { usageStats: extra.usageStats } : {}),
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

  it("rotates past last-used profile on new session with no current override", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "zai:a": { type: "api_key", provider: "zai", key: "sk-a" },
          "zai:b": { type: "api_key", provider: "zai", key: "sk-b" },
          "zai:c": { type: "api_key", provider: "zai", key: "sk-c" },
        },
        order: { zai: ["zai:a", "zai:b", "zai:c"] },
        usageStats: {
          "zai:a": { lastUsed: 1000 },
          "zai:b": { lastUsed: 3000 },
          "zai:c": { lastUsed: 2000 },
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s-new",
        updatedAt: Date.now(),
        // no authProfileOverride — simulates /new or /reset
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

      // "zai:b" was last used (t=3000), so rotation should pick "zai:c" (next in order)
      expect(resolved).toBe("zai:c");
      expect(sessionEntry.authProfileOverride).toBe("zai:c");
    });
  });

  it("falls back to first available when no usageStats exist on new session", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir, {
        profiles: {
          "zai:a": { type: "api_key", provider: "zai", key: "sk-a" },
          "zai:b": { type: "api_key", provider: "zai", key: "sk-b" },
        },
        order: { zai: ["zai:a", "zai:b"] },
        // no usageStats
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s-fresh",
        updatedAt: Date.now(),
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

      // No usage history → falls back to first available
      expect(resolved).toBe("zai:a");
      expect(sessionEntry.authProfileOverride).toBe("zai:a");
    });
  });
});
