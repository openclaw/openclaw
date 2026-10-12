import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const WORKBOARD_CARD_CHILD_INDEXES = [
  ["workboard_card_events", "workboard_card_events_card_idx"],
  ["workboard_card_attempts", "workboard_card_attempts_card_idx"],
  ["workboard_card_comments", "workboard_card_comments_card_idx"],
  ["workboard_card_links", "workboard_card_links_card_idx"],
  ["workboard_card_proof", "workboard_card_proof_card_idx"],
  ["workboard_card_artifacts", "workboard_card_artifacts_card_idx"],
  ["workboard_card_notifications", "workboard_card_notifications_card_idx"],
  ["workboard_worker_logs", "workboard_worker_logs_card_idx"],
] as const;

function explainWorkboardQueryPlan(
  db: DatabaseSync,
  sql: string,
  params: readonly (number | string | null)[] = [],
): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail?: unknown;
  }>;
  return rows
    .map((row) => (typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail ?? "")))
    .join("\n");
}

describe("Workboard SQLite schema admission", () => {
  it("restores dropped card child indexes without changing the schema version", async () => {
    const dir = tempDirs.make("openclaw-workboard-index-reopen-");
    const dbPath = path.join(dir, "workboard.sqlite");
    const initialized = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    await initialized.ready;
    await initialized.close();
    // Build the old format on a physical file this process has not admitted.
    fs.renameSync(dbPath, `${dbPath}.seed`);
    fs.copyFileSync(`${dbPath}.seed`, dbPath);
    const db = new DatabaseSync(dbPath);
    let initialMigrationIds: Array<{ id: string }>;
    try {
      initialMigrationIds = db
        .prepare("SELECT id FROM workboard_schema_migrations ORDER BY id")
        .all() as Array<{ id: string }>;
      for (const [, index] of WORKBOARD_CARD_CHILD_INDEXES) {
        db.exec(`DROP INDEX ${index}`);
      }
    } finally {
      db.close();
    }

    const reopened = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    await reopened.ready;
    await reopened.close();
    const verified = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const indexes = new Set(
        (
          verified.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      for (const [table, index] of WORKBOARD_CARD_CHILD_INDEXES) {
        expect(indexes).toContain(index);
        const plan = explainWorkboardQueryPlan(
          verified,
          `SELECT * FROM ${table} WHERE card_id = ? ORDER BY ordinal ASC`,
          ["card-1"],
        );
        expect(plan).toContain(index);
        expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
      }
      expect(
        verified.prepare("SELECT id FROM workboard_schema_migrations ORDER BY id").all(),
      ).toEqual(initialMigrationIds);
    } finally {
      verified.close();
    }
  });

  it("migrates a version 2 workboard table to STRICT without losing rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-strict-migration-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const initialized = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    await initialized.ready;
    await initialized.close();
    // Build the old format on a physical file this process has not admitted.
    fs.renameSync(dbPath, `${dbPath}.seed`);
    fs.copyFileSync(`${dbPath}.seed`, dbPath);
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`
        INSERT INTO workboard_boards (
          id, name, description, icon, color, default_workspace_json, orchestration_json,
          created_at, updated_at, archived_at
        ) VALUES ('legacy', 'Legacy board', NULL, NULL, NULL, NULL, NULL, 1, 2, NULL);
        ALTER TABLE workboard_boards RENAME TO workboard_boards_strict;
        CREATE TABLE workboard_boards (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          icon TEXT,
          color TEXT,
          default_workspace_json TEXT,
          orchestration_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        INSERT INTO workboard_boards (
          id, name, description, icon, color, default_workspace_json, orchestration_json,
          created_at, updated_at, archived_at
        ) SELECT
          id, name, description, icon, color, default_workspace_json, orchestration_json,
          created_at, updated_at, archived_at
        FROM workboard_boards_strict;
        DROP TABLE workboard_boards_strict;
        DELETE FROM workboard_schema_migrations WHERE id = 'schema-3';
        INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at)
        VALUES ('schema-2', 1);
      `);
    } finally {
      legacy.close();
    }

    try {
      const migratedStores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
      try {
        await expect(migratedStores.boards.lookup("legacy")).resolves.toMatchObject({
          board: { id: "legacy", name: "Legacy board" },
        });
      } finally {
        await migratedStores.close();
      }
      const migrated = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          migrated
            .prepare("SELECT strict FROM pragma_table_list WHERE name = 'workboard_boards'")
            .get(),
        ).toEqual({ strict: 1 });
        expect(
          migrated
            .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = 'schema-3'")
            .get(),
        ).toEqual({ found: 1 });
      } finally {
        migrated.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
