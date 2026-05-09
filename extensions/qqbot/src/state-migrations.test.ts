import fs from "node:fs/promises";
import path from "node:path";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/session-store-runtime";
import { createTrackedTempDirs } from "openclaw/plugin-sdk/test-env";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { detectQQBotLegacyStateMigrations } from "./state-migrations.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("qqbot state migrations", () => {
  it("imports legacy plugin files into SQLite plugin state", async () => {
    const root = await tempDirs.make("qqbot-state-migrations-");
    const stateDir = path.join(root, ".openclaw");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const now = Date.now();

    await fs.mkdir(path.join(stateDir, "qqbot", "data"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "qqbot", "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "qqbot", "data", "known-users.json"),
      `${JSON.stringify([
        {
          openid: "user-1",
          type: "group",
          groupOpenid: "group-1",
          accountId: "qq-main",
          firstSeenAt: now - 10,
          lastSeenAt: now,
          interactionCount: 2,
        },
      ])}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "qqbot", "data", "ref-index.jsonl"),
      `${JSON.stringify({
        k: "ref-1",
        v: { content: "hello", senderId: "user-1", timestamp: now },
        t: now,
      })}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "qqbot", "sessions", "session-cXEtbWFpbg.json"),
      `${JSON.stringify({
        sessionId: "session-1",
        lastSeq: 12,
        lastConnectedAt: now,
        intentLevelIndex: 0,
        accountId: "qq-main",
        savedAt: now,
        appId: "app-1",
      })}\n`,
      "utf8",
    );

    const plans = detectQQBotLegacyStateMigrations({ stateDir });
    expect(plans.map((plan) => plan.label)).toEqual([
      "QQBot known users",
      "QQBot ref-index",
      "QQBot gateway session",
    ]);

    const results = await Promise.all(
      plans.map(async (plan) =>
        plan.kind === "custom"
          ? plan.apply({ cfg: {}, env, stateDir, oauthDir: path.join(stateDir, "credentials") })
          : { changes: [], warnings: [] },
      ),
    );
    expect(results.flatMap((result) => result.warnings)).toEqual([]);
    expect(results.flatMap((result) => result.changes)).toEqual([
      "Imported 1 QQBot known users row(s) into SQLite plugin state (qqbot/known-users)",
      "Imported 1 QQBot ref-index row(s) into SQLite plugin state (qqbot/ref-index)",
      "Imported 1 QQBot gateway session row(s) into SQLite plugin state (qqbot/sessions)",
    ]);

    const database = openOpenClawStateDatabase({ env });
    const rows = database.db
      .prepare(
        "SELECT namespace, entry_key FROM plugin_state_entries WHERE plugin_id = ? ORDER BY namespace, entry_key",
      )
      .all("qqbot") as Array<{ namespace: string; entry_key: string }>;
    expect(rows.map((row) => `${row.namespace}:${row.entry_key}`)).toEqual([
      "known-users:qq-main:group:user-1:group-1",
      "ref-index:ref-1",
      "sessions:qq-main",
    ]);

    await expect(
      fs.stat(path.join(stateDir, "qqbot", "data", "known-users.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(stateDir, "qqbot", "data", "ref-index.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(stateDir, "qqbot", "sessions", "session-cXEtbWFpbg.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
