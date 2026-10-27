import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  closeOpenClawStateDatabaseAsync,
  withStateMigrationBackupForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStoreAgentIds, stateMigrations } from "./doctor-contract-api.js";
import { installVoiceCallStateRuntimeForTests } from "./src/manager.test-harness.js";
import { loadActiveCallsFromStore } from "./src/manager/store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.doUnmock("openclaw/plugin-sdk/doctor-repair-runtime");
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  });
});

function pluginConfig(config: Record<string, unknown>, id = "voice-call") {
  return { plugins: { entries: { [id]: { config } } } };
}

function migrationParams(stateDir: string, store?: string, home = stateDir) {
  const env = { ...process.env, HOME: home, OPENCLAW_STATE_DIR: stateDir };
  return {
    config: store ? pluginConfig({ store }) : {},
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context: {
      openPluginStateKeyedStore: (options) =>
        createPluginStateKeyedStoreForTests("voice-call", { ...options, env: options.env ?? env }),
    } satisfies PluginDoctorStateMigrationContext,
  };
}

it.each(["detectLegacyState", "migrateLegacyState"] as const)(
  "%s leaves absent state untouched without loading repair machinery",
  async (method) => {
    const root = tempDirs.make("openclaw-voice-call-absent-");
    vi.doMock("openclaw/plugin-sdk/doctor-repair-runtime", () => {
      throw new Error("absent Voice Call state must not load repair machinery");
    });
    const migration = expectDefined(stateMigrations[1], "voice-call schema migration");
    const result = await migration[method](migrationParams(root));
    expect(result).toEqual(method === "detectLegacyState" ? null : { changes: [], warnings: [] });
    expect(await fs.readdir(root)).toEqual([]);
  },
);

describe("voice-call doctor state migration", () => {
  let stateDir = "";
  let storePath = "";
  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = tempDirs.make("openclaw-voice-call-doctor-");
    storePath = path.join(stateDir, "custom-store");
    installVoiceCallStateRuntimeForTests();
  });

  it.each([
    [
      pluginConfig({ agentId: "Voice", numbers: { a: { agentId: "Cards" }, b: {} } }),
      ["cards", "voice"],
    ],
    [pluginConfig({}, "@openclaw/voice-call"), ["main"]],
    [{ plugins: { entries: { "voice-call": { enabled: true } } } }, ["main"]],
  ] as const)("reports session-store agents for %j", (cfg, expected) => {
    expect(resolveSessionStoreAgentIds({ cfg })).toEqual(expected);
  });

  it.each(["voice-calls", "custom-store", "home$&d/dollar-store"])(
    "refuses the retired %s call log without changing its bytes or creating SQLite state",
    async (location) => {
      const store = path.join(stateDir, location);
      await fs.mkdir(store, { recursive: true });
      const source = path.join(store, "calls.jsonl");
      const bytes = Buffer.from('{"callId":"unmigrated"}\n{invalid retained bytes\n');
      await fs.writeFile(source, bytes);
      const migration = expectDefined(stateMigrations[0], "retired call-log migration");
      const params = migrationParams(
        stateDir,
        location === "voice-calls"
          ? undefined
          : location === "custom-store"
            ? store
            : "~/dollar-store",
        path.join(stateDir, "home$&d"),
      );
      await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
        preview: [expect.stringContaining(source)],
      });
      await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
        changes: [],
        warnings: [expect.stringContaining("2026.9.7")],
      });
      expect(await fs.readFile(source)).toEqual(bytes);
      expect(await fs.readdir(store)).toEqual(["calls.jsonl"]);
    },
  );

  it("repairs the plugin-local SQLite schema without a legacy call log", async () => {
    const databasePath = path.join(storePath, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          source_id TEXT NOT NULL UNIQUE, source_sequence INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
          kind TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT,
          actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, agent_id TEXT NOT NULL,
          session_key TEXT, session_id TEXT, run_id TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT
        );
      `);
    } finally {
      db.close();
    }
    const migration = expectDefined(stateMigrations[1], "voice-call schema migration");
    const params = migrationParams(stateDir, storePath);

    await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: expect.arrayContaining([
        "- Voice Call SQLite schema: audit event ledger -> versioned message lifecycle schema",
        "- Voice Call SQLite schema: tables -> SQLite STRICT typing",
      ]),
    });
    await expect(
      withStateMigrationBackupForTest({ env: params.env }, () =>
        migration.migrateLegacyState(params),
      ),
    ).resolves.toEqual({
      changes: expect.arrayContaining([
        "Migrated Voice Call SQLite audit event ledger -> versioned message lifecycle schema",
        expect.stringMatching(
          /^Migrated Voice Call SQLite tables to SQLite STRICT typing \(\d+\)$/,
        ),
      ]),
      warnings: [],
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
  });
});
