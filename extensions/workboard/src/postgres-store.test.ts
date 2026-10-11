import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessagePort } from "node:worker_threads";
import {
  hasSqliteWorkerOutcomeUnknown,
  readSqliteDatabaseWriteTokenForPath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  PostgresSyncConnection,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorkboardDatabase } from "./sqlite-store-schema.js";

const postgresUrl = process.env.OPENCLAW_EXPERIMENTAL_POSTGRES_URL;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!postgresUrl)("experimental PostgreSQL workboard admission and receipts", () => {
  const observer = new Client({ connectionString: postgresUrl });
  const owners: Array<ReturnType<typeof createWorkboardDatabase>> = [];
  const schemas = new Set<string>();

  beforeAll(async () => {
    await observer.connect();
  });

  afterEach(async () => {
    try {
      for (const owner of owners.splice(0).toReversed()) {
        owner.close();
      }
    } finally {
      for (const schema of schemas) {
        await observer.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      }
      schemas.clear();
    }
  });

  afterAll(async () => {
    await observer.end();
  });

  function databasePath(): string {
    return path.join(tempDirs.make("openclaw-workboard-postgres-"), "workboard.sqlite");
  }

  function openDatabase(dbPath: string) {
    const owner = createWorkboardDatabase(dbPath);
    owners.push(owner);
    const db = owner.db;
    if (!(db instanceof PostgresSyncConnection)) {
      throw new Error("Experimental workboard open did not select PostgreSQL");
    }
    schemas.add(db.schema);
    return { db, close: owner.close };
  }

  it("retains a real SQLite anchor and reopens the same PostgreSQL schema", async () => {
    const dbPath = databasePath();
    const first = openDatabase(dbPath);
    runSqliteImmediateTransactionSync(first.db, () => {
      first.db
        .prepare(
          "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("board", "Persisted remotely", 1, 2);
    });
    const persisted = await observer.query<{ name: string }>(
      `SELECT name FROM ${quoteIdentifier(first.db.schema)}.workboard_boards WHERE id = $1`,
      ["board"],
    );
    expect(persisted.rows).toEqual([{ name: "Persisted remotely" }]);
    const schema = first.db.schema;
    first.close();

    const reopened = openDatabase(dbPath);
    expect(reopened.db.schema).toBe(schema);
    expect(
      reopened.db.prepare("SELECT name FROM workboard_boards WHERE id = ?").get("board"),
    ).toEqual({ name: "Persisted remotely" });
    reopened.close();

    using anchor = new DatabaseSync(dbPath, { readOnly: true });
    expect(anchor.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(
      anchor.prepare("SELECT name FROM sqlite_schema WHERE name = 'workboard_boards'").get(),
    ).toBeUndefined();
  });

  it("publishes the anchor receipt after a PostgreSQL commit but not after rollback or failure", async () => {
    const dbPath = databasePath();
    const { db } = openDatabase(dbPath);
    const before = readSqliteDatabaseWriteTokenForPath(dbPath);
    expect(before).toBeDefined();
    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO workboard_boards (id, created_at, updated_at) VALUES (?, ?, ?)").run(
        "committed",
        1,
        2,
      );
    });
    const committed = readSqliteDatabaseWriteTokenForPath(dbPath);
    expect(committed).toBeDefined();
    expect(committed).not.toBe(before);
    expect(
      (
        await observer.query<{ id: string }>(
          `SELECT id FROM ${quoteIdentifier(db.schema)}.workboard_boards ORDER BY id`,
        )
      ).rows,
    ).toEqual([{ id: "committed" }]);

    const rejected = new Error("roll back this write");
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare(
          "INSERT INTO workboard_boards (id, created_at, updated_at) VALUES (?, ?, ?)",
        ).run("rolled-back", 3, 4);
        throw rejected;
      }),
    ).toThrow(rejected);
    expect(readSqliteDatabaseWriteTokenForPath(dbPath)).toBe(committed);

    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare(
          "INSERT INTO workboard_boards (id, created_at, updated_at) VALUES (?, ?, ?)",
        ).run("failed", 5, 6);
        db.prepare(
          "INSERT INTO workboard_boards (id, created_at, updated_at) VALUES (?, ?, ?)",
        ).run("committed", 5, 6);
      }),
    ).toThrow("UNIQUE constraint failed");
    expect(readSqliteDatabaseWriteTokenForPath(dbPath)).toBe(committed);
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare(
          "INSERT INTO workboard_boards (id, created_at, updated_at) VALUES (?, ?, ?)",
        ).run("caught", 7, 8);
        try {
          db.prepare(
            "INSERT INTO workboard_boards (id, created_at, updated_at) VALUES (?, ?, ?)",
          ).run("committed", 7, 8);
        } catch {
          // The server transaction stays aborted even if a caller consumes its error.
        }
      }),
    ).toThrow("rolled back instead of committing");
    expect(readSqliteDatabaseWriteTokenForPath(dbPath)).toBe(committed);
    expect(
      (
        await observer.query<{ id: string }>(
          `SELECT id FROM ${quoteIdentifier(db.schema)}.workboard_boards ORDER BY id`,
        )
      ).rows,
    ).toEqual([{ id: "committed" }]);
  });

  it.each([
    ["COMMIT", true],
    ["SELECT 1", false],
  ] as const)("classifies terminated PostgreSQL sessions before %s", async (statement, unknown) => {
    const dbPath = databasePath();
    const { db } = openDatabase(dbPath);
    const pid = db.prepare("SELECT pg_backend_pid() AS pid").get()?.pid;
    expect(typeof pid).toBe("number");
    const token = readSqliteDatabaseWriteTokenForPath(dbPath);
    db.exec("BEGIN ISOLATION LEVEL READ COMMITTED");
    db.prepare("INSERT INTO workboard_boards (id, created_at, updated_at) VALUES (?, ?, ?)").run(
      "discarded",
      1,
      2,
    );
    // The timeout form joins server termination instead of polling for it.
    const terminated = await observer.query<{ terminated: boolean }>(
      "SELECT pg_terminate_backend($1, 5000) AS terminated",
      [pid],
    );
    expect(terminated.rows).toEqual([{ terminated: true }]);
    let failure: unknown;
    try {
      db.exec(statement);
    } catch (error) {
      failure = error;
    }
    const message = unknown
      ? "PostgreSQL connection lost; outcome unknown"
      : "PostgreSQL connection lost; transaction rolled back";
    expect(failure).toMatchObject({ message });
    expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(unknown);
    expect(db.isOpen).toBe(false);
    using sent = vi.spyOn(MessagePort.prototype, "postMessage");
    expect(() => db.exec("SELECT 2")).toThrow(message);
    expect(sent).not.toHaveBeenCalled();
    expect(readSqliteDatabaseWriteTokenForPath(dbPath)).toBe(token);
    const persisted = await observer.query(
      `SELECT id FROM ${quoteIdentifier(db.schema)}.workboard_boards`,
    );
    expect(persisted.rows).toEqual([]);
  });

  it("keeps the connection usable after a deferred constraint fails at COMMIT", () => {
    const { db } = openDatabase(databasePath());
    const pid = db.prepare("SELECT pg_backend_pid() AS pid").get()?.pid;
    db.exec("CREATE TABLE deferred_unique (id INTEGER UNIQUE DEFERRABLE INITIALLY DEFERRED)");
    db.exec("BEGIN");
    db.exec("INSERT INTO deferred_unique VALUES (1), (1)");
    let failure: unknown;
    try {
      db.exec("COMMIT");
    } catch (error) {
      failure = error;
    }
    expect(db.isTransaction).toBe(false);
    expect(failure).toMatchObject({
      code: "ERR_SQLITE_ERROR",
      errcode: 2067,
      cause: { code: "23505" },
    });
    expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(false);
    expect(db.isOpen).toBe(true);
    expect(db.prepare("SELECT pg_backend_pid() AS pid").get()?.pid).toBe(pid);
    runSqliteImmediateTransactionSync(db, () => db.exec("INSERT INTO deferred_unique VALUES (2)"));
    expect(db.prepare("SELECT id FROM deferred_unique").all()).toEqual([{ id: 2 }]);
  });

  it("refuses a PostgreSQL anchor when the experimental URL is unset without creating SQLite data", () => {
    const dbPath = databasePath();
    const opened = openDatabase(dbPath);
    const schema = opened.db.schema;
    runSqliteImmediateTransactionSync(opened.db, () => {
      opened.db
        .prepare(
          "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("remote", "Keep remote data", 1, 2);
    });
    opened.close();
    const snapshotAnchor = () => {
      using anchor = new DatabaseSync(dbPath, { readOnly: true });
      return {
        schema: anchor.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
        rows: anchor.prepare("SELECT * FROM openclaw_engine_anchor").all(),
        workboardTables: anchor
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'workboard_%'",
          )
          .all(),
      };
    };
    const before = snapshotAnchor();
    expect(before.workboardTables).toEqual([]);
    try {
      vi.stubEnv("OPENCLAW_EXPERIMENTAL_POSTGRES_URL", undefined);
      let failure: unknown;
      try {
        owners.push(createWorkboardDatabase(dbPath));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: expect.stringContaining(schema) });
      expect(failure).toMatchObject({
        message: expect.stringContaining("OPENCLAW_EXPERIMENTAL_POSTGRES_URL"),
      });
      expect(snapshotAnchor()).toEqual(before);
    } finally {
      vi.stubEnv("OPENCLAW_EXPERIMENTAL_POSTGRES_URL", postgresUrl);
    }
    const reopened = openDatabase(dbPath);
    expect(reopened.db.schema).toBe(schema);
    expect(
      reopened.db.prepare("SELECT name FROM workboard_boards WHERE id = ?").get("remote"),
    ).toEqual({ name: "Keep remote data" });
  });

  it("refuses a PostgreSQL schema version mismatch without migrating it", async () => {
    const dbPath = databasePath();
    const opened = openDatabase(dbPath);
    const schema = opened.db.schema;
    opened.close();
    await observer.query(
      `UPDATE ${quoteIdentifier(schema)}.openclaw_schema_meta SET version = 4 WHERE store = 'workboard'`,
    );
    expect(() => createWorkboardDatabase(dbPath)).toThrow(/expected.*3/i);
    expect(
      (
        await observer.query<{ version: number }>(
          `SELECT version::integer FROM ${quoteIdentifier(schema)}.openclaw_schema_meta WHERE store = 'workboard'`,
        )
      ).rows,
    ).toEqual([{ version: 4 }]);
  });

  it("refuses PostgreSQL metadata belonging to a different anchor", async () => {
    const dbPath = databasePath();
    const opened = openDatabase(dbPath);
    const schema = opened.db.schema;
    opened.close();
    const metadata = await observer.query<{ store_id: string }>(
      `SELECT store_id FROM ${quoteIdentifier(schema)}.openclaw_schema_meta WHERE store = 'workboard'`,
    );
    expect(metadata.rows).toHaveLength(1);
    const originalId = metadata.rows[0]!.store_id;
    const otherId = "00000000-0000-4000-8000-000000000001";
    await observer.query(
      `UPDATE ${quoteIdentifier(schema)}.openclaw_schema_meta SET store_id = $1 WHERE store = 'workboard'`,
      [otherId],
    );
    expect(() => createWorkboardDatabase(dbPath)).toThrow(
      new RegExp(`${originalId}.*${otherId}|${otherId}.*${originalId}`),
    );
    expect(
      (
        await observer.query<{ store_id: string }>(
          `SELECT store_id FROM ${quoteIdentifier(schema)}.openclaw_schema_meta WHERE store = 'workboard'`,
        )
      ).rows,
    ).toEqual([{ store_id: otherId }]);
  });

  it("refuses an existing SQLite workboard without replacing its data", () => {
    const dbPath = databasePath();
    {
      using existing = new DatabaseSync(dbPath);
      existing.exec("CREATE TABLE workboard_boards (id TEXT PRIMARY KEY, name TEXT)");
      existing.prepare("INSERT INTO workboard_boards VALUES (?, ?)").run("local", "Keep me");
    }
    expect(() => createWorkboardDatabase(dbPath)).toThrow(
      "Existing SQLite workboard data cannot switch engines",
    );
    using preserved = new DatabaseSync(dbPath, { readOnly: true });
    expect(preserved.prepare("SELECT * FROM workboard_boards").all()).toEqual([
      { id: "local", name: "Keep me" },
    ]);
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
