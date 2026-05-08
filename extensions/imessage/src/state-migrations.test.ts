import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { detectIMessageLegacyStateMigrations } from "./state-migrations.js";

function createReplyCacheStore(env: NodeJS.ProcessEnv) {
  return createPluginStateSyncKeyedStore<{
    accountId: string;
    messageId: string;
    shortId: string;
    timestamp: number;
  }>("imessage", {
    namespace: "reply-cache",
    maxEntries: 2000,
    defaultTtlMs: 6 * 60 * 60 * 1000,
    env,
  });
}

function createSentEchoStore(env: NodeJS.ProcessEnv) {
  return createPluginStateSyncKeyedStore<{
    scope: string;
    text?: string;
    messageId?: string;
    timestamp: number;
  }>("imessage", {
    namespace: "sent-echoes",
    maxEntries: 256,
    defaultTtlMs: 2 * 60 * 1000,
    env,
  });
}

describe("iMessage legacy state migrations", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  function createStateDir(): string {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-migration-"));
    fs.mkdirSync(path.join(stateDir, "imessage"), { recursive: true });
    return stateDir;
  }

  it("imports legacy reply-cache.jsonl into SQLite plugin state", async () => {
    const stateDir = createStateDir();
    try {
      const sourcePath = path.join(stateDir, "imessage", "reply-cache.jsonl");
      fs.writeFileSync(
        sourcePath,
        `${JSON.stringify({
          accountId: "default",
          messageId: "guid-1",
          shortId: "7",
          timestamp: Date.now(),
          chatIdentifier: "+15555550123",
        })}\n`,
      );

      const plans = detectIMessageLegacyStateMigrations({ stateDir });
      expect(plans.map((plan) => plan.label)).toContain("iMessage reply cache");
      const plan = plans.find((entry) => entry.label === "iMessage reply cache");
      expect(plan?.kind).toBe("custom");
      if (!plan || plan.kind !== "custom") {
        return;
      }

      const env = { OPENCLAW_STATE_DIR: stateDir };
      const result = await plan.apply({
        cfg: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
      });

      expect(result.changes.join("\n")).toContain("Imported 1 iMessage reply cache row");
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(
        createReplyCacheStore(env)
          .entries()
          .map((entry) => entry.value.messageId),
      ).toEqual(["guid-1"]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("imports legacy sent-echoes.jsonl into SQLite plugin state", async () => {
    const stateDir = createStateDir();
    try {
      const sourcePath = path.join(stateDir, "imessage", "sent-echoes.jsonl");
      fs.writeFileSync(
        sourcePath,
        `${JSON.stringify({
          scope: "acct:imessage:+1555",
          text: "OpenClaw imsg live test",
          messageId: "guid-1",
          timestamp: Date.now(),
        })}\n`,
      );

      const plans = detectIMessageLegacyStateMigrations({ stateDir });
      expect(plans.map((plan) => plan.label)).toContain("iMessage sent echo cache");
      const plan = plans.find((entry) => entry.label === "iMessage sent echo cache");
      expect(plan?.kind).toBe("custom");
      if (!plan || plan.kind !== "custom") {
        return;
      }

      const env = { OPENCLAW_STATE_DIR: stateDir };
      const result = await plan.apply({
        cfg: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
      });

      expect(result.changes.join("\n")).toContain("Imported 1 iMessage sent echo cache row");
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(
        createSentEchoStore(env)
          .entries()
          .map((entry) => entry.value.messageId),
      ).toEqual(["guid-1"]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
