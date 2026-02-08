import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome as withTempHomeBase } from "../../../test/helpers/temp-home.js";
import { resolveIsolatedSession } from "./session.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-isolated-session-" });
}

async function writeSessionStore(home: string, data: Record<string, unknown> = {}) {
  const dir = path.join(home, ".openclaw", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(data, null, 2), "utf-8");
  return storePath;
}

function makeCfg(storePath: string): OpenClawConfig {
  return {
    session: { store: storePath },
  } as OpenClawConfig;
}

describe("resolveIsolatedSession", () => {
  it("creates a new session with fresh UUID", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const cfg = makeCfg(storePath);

      const result = resolveIsolatedSession({
        cfg,
        sessionKey: "test:key",
        agentId: "main",
        nowMs: Date.now(),
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionEntry.sessionId).toBeDefined();
      expect(result.sessionEntry.sessionId.length).toBe(36); // UUID format
      expect(result.sessionEntry.systemSent).toBe(false);
    });
  });

  it("preserves settings from existing session entry", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, {
        "test:key": {
          sessionId: "old-session",
          thinkingLevel: "high",
          verboseLevel: "verbose",
          model: "anthropic/claude-3-opus",
          contextTokens: 100000,
          lastChannel: "telegram",
          lastTo: "123456",
        },
      });
      const cfg = makeCfg(storePath);

      const result = resolveIsolatedSession({
        cfg,
        sessionKey: "test:key",
        agentId: "main",
        nowMs: Date.now(),
      });

      // New session ID but preserved settings
      expect(result.sessionEntry.sessionId).not.toBe("old-session");
      expect(result.sessionEntry.thinkingLevel).toBe("high");
      expect(result.sessionEntry.verboseLevel).toBe("verbose");
      expect(result.sessionEntry.model).toBe("anthropic/claude-3-opus");
      expect(result.sessionEntry.contextTokens).toBe(100000);
      expect(result.sessionEntry.lastChannel).toBe("telegram");
      expect(result.sessionEntry.lastTo).toBe("123456");
    });
  });

  it("returns empty settings when no existing session", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, {});
      const cfg = makeCfg(storePath);

      const result = resolveIsolatedSession({
        cfg,
        sessionKey: "nonexistent:key",
        agentId: "main",
        nowMs: Date.now(),
      });

      expect(result.sessionEntry.thinkingLevel).toBeUndefined();
      expect(result.sessionEntry.verboseLevel).toBeUndefined();
      expect(result.sessionEntry.model).toBeUndefined();
    });
  });
});
