import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../../config/sessions.js";
import {
  clearSessionAuthProfileOverride,
  resolveSessionAuthProfileOverride,
} from "./session-override.js";

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
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    try {
      const agentDir = path.join(tmpDir, "agent");
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
    } finally {
      if (prevStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("clears auth-profile override without clobbering fresher persisted fields", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const sessionKey = "agent:main:main";
    const storePath = path.join(tmpDir, "sessions.json");
    try {
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 3,
      };
      const sessionStore = { [sessionKey]: sessionEntry };
      await saveSessionStore(storePath, {
        [sessionKey]: {
          ...sessionEntry,
          lastTo: "fresh-recipient",
        },
      });

      await clearSessionAuthProfileOverride({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.authProfileOverride).toBeUndefined();
      expect(persisted?.authProfileOverrideSource).toBeUndefined();
      expect(persisted?.authProfileOverrideCompactionCount).toBeUndefined();
      expect(persisted?.lastTo).toBe("fresh-recipient");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
