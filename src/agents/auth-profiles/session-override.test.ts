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

async function writeAuthStoreWithProfiles(
  agentDir: string,
  params: {
    profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
    order?: Record<string, string[]>;
  },
) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  await fs.writeFile(
    authPath,
    JSON.stringify(
      {
        version: 1,
        profiles: params.profiles,
        ...(params.order ? { order: params.order } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

const TEST_PRIMARY_PROFILE_ID = "openai-codex:primary@example.test";
const TEST_SECONDARY_PROFILE_ID = "openai-codex:secondary@example.test";

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

  it("keeps explicit user override when stored order prefers another profile", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStoreWithProfiles(agentDir, {
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-josh",
          },
          [TEST_SECONDARY_PROFILE_ID]: {
            type: "api_key",
            provider: "openai-codex",
            key: "sk-claude",
          },
        },
        order: {
          "openai-codex": [TEST_PRIMARY_PROFILE_ID],
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: TEST_SECONDARY_PROFILE_ID,
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
        isNewSession: false,
      });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
    });
  });
});
