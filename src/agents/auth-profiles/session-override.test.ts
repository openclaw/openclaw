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

async function writeTwoProfileAuthStore(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-default" },
      "anthropic:secondary": { type: "api_key", provider: "anthropic", key: "sk-secondary" },
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

  it("rotates to second profile on second /new when both profiles start fresh", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeTwoProfileAuthStore(agentDir);

      // First /new session — no prior override
      const session1: SessionEntry = { sessionId: "s1", updatedAt: Date.now() };
      const store1 = { "agent:main:main": session1 };
      const profile1 = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "anthropic",
        agentDir,
        sessionEntry: session1,
        sessionStore: store1,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });
      expect(profile1).toBeTruthy();

      // Second /new session — should pick a different profile (round-robin),
      // even though markAuthProfileUsed has not been called (run not complete).
      const session2: SessionEntry = { sessionId: "s2", updatedAt: Date.now() };
      const store2 = { "agent:main:main": session2 };
      const profile2 = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "anthropic",
        agentDir,
        sessionEntry: session2,
        sessionStore: store2,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: true,
      });
      expect(profile2).toBeTruthy();
      expect(profile2).not.toBe(profile1);
    });
  });

  it("rotates through all profiles across rapid /new sequences", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeTwoProfileAuthStore(agentDir);

      const selected: string[] = [];
      // Simulate 4 rapid /new sessions — no run completion between them
      for (let i = 0; i < 4; i++) {
        const entry: SessionEntry = { sessionId: `s${i}`, updatedAt: Date.now() };
        const store = { "agent:main:main": entry };
        const profile = await resolveSessionAuthProfileOverride({
          cfg: {} as OpenClawConfig,
          provider: "anthropic",
          agentDir,
          sessionEntry: entry,
          sessionStore: store,
          sessionKey: "agent:main:main",
          storePath: undefined,
          isNewSession: true,
        });
        expect(profile).toBeTruthy();
        selected.push(profile!);
      }

      // Both profiles should appear — no profile selected 4 times in a row
      const unique = new Set(selected);
      expect(unique.size).toBe(2);
      // Pattern must alternate (A, B, A, B or B, A, B, A)
      expect(selected[0]).not.toBe(selected[1]);
      expect(selected[1]).not.toBe(selected[2]);
      expect(selected[2]).not.toBe(selected[3]);
    });
  });
});
