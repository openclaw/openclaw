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

async function writeAuthStoreMultiProvider(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "openai:main": { type: "api_key", provider: "openai", key: "sk-openai" },
      "anthropic:main": { type: "api_key", provider: "anthropic", key: "sk-anthropic" },
    },
    order: {
      openai: ["openai:main"],
      anthropic: ["anthropic:main"],
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

      expect(resolved.authProfileId).toBe("zai:work");
      expect(resolved.authProfileIdSource).toBe("user");
      expect(sessionEntry.authProfileOverride).toBe("zai:work");
    });
  });

  it("updates in-memory source to auto for transient image-provider auth pick", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStoreMultiProvider(agentDir);

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "openai:main",
        authProfileOverrideSource: "user",
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
        hasAppliedImageModelOverride: true,
      });

      expect(resolved.authProfileId).toBe("anthropic:main");
      expect(resolved.authProfileIdSource).toBe("auto");
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.authProfileOverride).toBe("openai:main");
    });
  });
});
