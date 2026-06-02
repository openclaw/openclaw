import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectQQBotLegacyStateMigrations } from "./state-migrations.js";

const createdDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("qqbot state migrations", () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects credential backups as doctor-owned plugin-state imports", async () => {
    const stateDir = createTempDir("qqbot-state-");
    const sourcePath = path.join(stateDir, "qqbot", "data", "credential-backup-default.json");
    writeJson(sourcePath, {
      accountId: "default",
      appId: "app-1",
      clientSecret: "secret-1",
      savedAt: "2026-06-02T00:00:00.000Z",
    });

    const plans = detectQQBotLegacyStateMigrations({ env: {}, stateDir });

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan).toMatchObject({
      kind: "plugin-state-import",
      label: "QQBot credential backup",
      sourcePath,
      pluginId: "qqbot",
      namespace: "credential-backups",
      cleanupSource: "rename",
    });
    if (plan?.kind !== "plugin-state-import") {
      throw new Error("expected plugin-state-import plan");
    }
    const [entry] = await plan.readEntries();
    expect(entry).toMatchObject({
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
      value: {
        accountId: "default",
        appId: "app-1",
        clientSecret: "secret-1",
        savedAt: "2026-06-02T00:00:00.000Z",
      },
    });
  });

  it("keeps per-account credential backups ahead of legacy single-file backups", async () => {
    const stateDir = createTempDir("qqbot-state-");
    const dataDir = path.join(stateDir, "qqbot", "data");
    writeJson(path.join(dataDir, "credential-backup.json"), {
      accountId: "default",
      appId: "stale-app",
      clientSecret: "stale-secret",
      savedAt: "2026-06-01T00:00:00.000Z",
    });
    writeJson(path.join(dataDir, "credential-backup-default.json"), {
      accountId: "default",
      appId: "current-app",
      clientSecret: "current-secret",
      savedAt: "2026-06-02T00:00:00.000Z",
    });

    const plans = detectQQBotLegacyStateMigrations({ env: {}, stateDir });

    expect(plans).toHaveLength(2);
    const [firstPlan] = plans;
    if (firstPlan?.kind !== "plugin-state-import") {
      throw new Error("expected plugin-state-import plan");
    }
    const [entry] = await firstPlan.readEntries();
    expect(entry?.value).toMatchObject({
      accountId: "default",
      appId: "current-app",
      clientSecret: "current-secret",
    });
  });

  it("does not trust mismatched per-account backup filenames", () => {
    const stateDir = createTempDir("qqbot-state-");
    const dataDir = path.join(stateDir, "qqbot", "data");
    writeJson(path.join(dataDir, "credential-backup-other.json"), {
      accountId: "default",
      appId: "wrong-app",
      clientSecret: "wrong-secret",
      savedAt: "2026-06-02T00:00:00.000Z",
    });

    expect(detectQQBotLegacyStateMigrations({ env: {}, stateDir })).toEqual([]);
  });

  it("does not migrate QQBot runtime caches", () => {
    const stateDir = createTempDir("qqbot-state-");
    const homeDir = createTempDir("qqbot-home-");
    writeJson(path.join(homeDir, ".openclaw", "qqbot", "sessions", "session-default.json"), {
      sessionId: "session-1",
    });
    writeJson(path.join(homeDir, ".openclaw", "qqbot", "data", "known-users.json"), []);
    fs.mkdirSync(path.join(homeDir, ".openclaw", "qqbot", "data"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".openclaw", "qqbot", "data", "ref-index.jsonl"),
      `${JSON.stringify({ k: "ref-1", v: {}, t: Date.now() })}\n`,
    );

    expect(detectQQBotLegacyStateMigrations({ env: { HOME: homeDir }, stateDir })).toEqual([]);
  });
});
