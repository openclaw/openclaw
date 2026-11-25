import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import {
  createPluginStateKeyedStoreForTests as createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { WORKBOARD_SCHEMA_SQL } from "./src/workboard-schema.js";

let stateDir: string;
let env: NodeJS.ProcessEnv;
const migration = expectDefined(stateMigrations[0], "Workboard retirement detector");

beforeAll(() => {
  // openclaw-temp-dir: allow closes the database owner before removing the suite fixture.
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-retired-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
});

afterAll(() => {
  resetPluginStateStoreForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function input(supportsCount: boolean) {
  const context: PluginDoctorStateMigrationContext = {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = createPluginStateKeyedStore<T>("workboard", options);
      return { ...store, count: supportsCount ? store.count : undefined };
    },
  };
  return { config: {}, env, stateDir, oauthDir: path.join(stateDir, "oauth"), context };
}

describe.each([true, false])("Workboard retirement with count support %s", (supportsCount) => {
  it("leaves installations without legacy rows alone", async () => {
    await expect(migration.detectLegacyState(input(supportsCount))).resolves.toBeNull();
    await expect(migration.migrateLegacyState(input(supportsCount))).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it.each([
    ["workboard.cards", 2000],
    ["workboard.boards", 200],
    ["workboard.notify", 2000],
    ["workboard.attachments", 42_000],
  ])("preserves %s rows and names the recovery release", async (namespace, maxEntries) => {
    const store = createPluginStateKeyedStore<unknown>("workboard", { namespace, maxEntries, env });
    await store.register("retained", { version: 1, retained: namespace });
    const before = await store.entries();
    try {
      await expect(migration.detectLegacyState(input(supportsCount))).resolves.toEqual({
        preview: [expect.stringContaining("2026.9.7 and run openclaw doctor --fix")],
      });
      const result = await migration.migrateLegacyState(input(supportsCount));
      expect(result).toEqual({
        changes: [],
        warnings: [expect.stringContaining("2026.9.7 and run openclaw doctor --fix")],
      });
      expect(await store.entries()).toEqual(before);
    } finally {
      await store.delete("retained");
    }
  });
});

it.each([false, true])(
  "repairs only orphan card rows (unrelated violations: %s)",
  async (mixed) => {
    const repair = expectDefined(
      stateMigrations.find(({ id }) => id === "workboard-card-orphans"),
      "Workboard orphan repair",
    );
    const repairState = path.join(stateDir, mixed ? "mixed" : "repair");
    const workboardDir = path.join(repairState, "plugins", "workboard");
    fs.mkdirSync(workboardDir, { recursive: true });
    const dbPath = path.join(workboardDir, "workboard.sqlite");
    const parameters = {
      ...input(true),
      stateDir: repairState,
      env: { ...env, OPENCLAW_STATE_DIR: repairState },
    };
    // Keep a raw handle open so committed orphan rows are still in the WAL.
    using db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    db.exec(WORKBOARD_SCHEMA_SQL);
    db.exec(`
    INSERT INTO workboard_cards (id, board_id, title, status, priority, position, created_at, updated_at)
      VALUES ('present', 'inbox', 'Keep this card', 'todo', 'normal', 1, 0, 0);
    INSERT INTO workboard_card_labels VALUES ('present', 0, 'keep'), ('missing', 0, 'retain in export');
    INSERT INTO workboard_card_events (id, card_id, ordinal, kind, at)
      VALUES ('event-1', 'missing', 0, 'created', 9007199254740993);
  `);
    if (mixed) {
      db.exec(`
      CREATE TABLE unrelated (card_id TEXT REFERENCES workboard_cards(id));
      INSERT INTO unrelated VALUES ('also-missing');
    `);
      const before = db.prepare("PRAGMA foreign_key_check").all();
      await expect(repair.migrateLegacyState(parameters)).rejects.toThrow(
        /unrelated foreign-key violations/u,
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual(before);
      expect(fs.readdirSync(workboardDir).filter((name) => name.includes("recovery"))).toEqual([]);
      return;
    }

    await expect(repair.detectLegacyState(parameters)).resolves.toEqual({
      preview: [expect.stringContaining("2 orphaned card rows")],
    });
    const result = await repair.migrateLegacyState(parameters);
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Recovered 2 orphaned Workboard card rows"),
    ]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT id, title FROM workboard_cards").all()).toEqual([
      { id: "present", title: "Keep this card" },
    ]);
    expect(db.prepare("SELECT label FROM workboard_card_labels").all()).toEqual([
      { label: "keep" },
    ]);
    const backups = () =>
      fs
        .readdirSync(workboardDir)
        .filter((name) => name.startsWith("openclaw-workboard-card-orphans-recovery-"));
    const directory = path.join(
      workboardDir,
      expectDefined(backups()[0], "Workboard recovery directory"),
    );
    using backup = new DatabaseSync(path.join(directory, "database.sqlite"), { readOnly: true });
    expect(backup.prepare("PRAGMA foreign_key_check").all()).toHaveLength(2);
    expect(backup.prepare("SELECT count(*) AS count FROM workboard_card_labels").get()).toEqual({
      count: 2,
    });
    expect(
      fs
        .readFileSync(path.join(directory, "orphan-rows.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        table: "workboard_card_events",
        row: expect.objectContaining({ id: "event-1", card_id: "missing", at: "9007199254740993" }),
      },
      {
        table: "workboard_card_labels",
        row: { card_id: "missing", ordinal: "0", label: "retain in export" },
      },
    ]);
    await expect(repair.detectLegacyState(parameters)).resolves.toBeNull();
    await expect(repair.migrateLegacyState(parameters)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(backups()).toHaveLength(1);
  },
);
