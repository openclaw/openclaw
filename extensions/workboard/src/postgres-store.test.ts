import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { readSqliteDatabaseWriteTokenForPath } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { unwrapWorkboardSqliteResult } from "./sqlite-store-errors.js";
import { createWorkboardDatabase } from "./sqlite-store-schema.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { workboardTestDatabaseInput } from "./test/database-config.js";
import { openPostgresFixture } from "./test/postgres-fixture.js";

const postgresInput = workboardTestDatabaseInput();
const postgresUrl = postgresInput?.connection;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!postgresUrl)("experimental PostgreSQL workboard admission and receipts", () => {
  const observer = new Client({ connectionString: postgresUrl });
  const owners: Array<{ close: () => Promise<void> }> = [];
  const schemas = new Set<string>();

  beforeAll(async () => {
    await observer.connect();
  });

  afterEach(async () => {
    try {
      for (const owner of owners.splice(0).toReversed()) {
        await owner.close();
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

  async function openDatabase(dbPath: string) {
    const owner = createWorkboardDatabase(dbPath, undefined, postgresInput);
    if (owner.db instanceof DatabaseSync) {
      owner.close();
      throw new Error("Experimental workboard open did not select PostgreSQL");
    }
    // The host anchor owns admission until the worker has released its connections.
    const fixture = openPostgresFixture({ dbPath, postgresInput });
    let closed = false;
    async function close() {
      if (closed) {
        return;
      }
      try {
        await fixture.close();
      } finally {
        owner.close();
        closed = true;
      }
    }
    owners.push({ close });
    const { schema } = await fixture.state();
    schemas.add(schema);
    return { fixture, schema, close };
  }

  const insertBoard = (id: string) => ({
    sql: "INSERT INTO workboard_boards (id, created_at, updated_at) VALUES (?, ?, ?)",
    method: "run" as const,
    args: [id, 1, 2],
  });

  it("resolves a host SecretRef and hands the configured connection to the worker", async () => {
    const dbPath = databasePath();
    const file = path.join(path.dirname(dbPath), "connection.json");
    fs.writeFileSync(file, JSON.stringify({ dsn: postgresUrl }), { mode: 0o600 });
    const stores = createWorkboardSqliteStores({
      dbPath,
      workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
      config: {
        database: {
          engine: "postgres",
          postgres: {
            connection: { source: "file", provider: "database", id: "/dsn" },
            schemaPrefix: "configured",
          },
        },
        secrets: { providers: { database: { source: "file", path: file } } },
      },
    });
    try {
      await stores.ready;
      await stores.boards.register("configured", {
        version: 1,
        board: { id: "configured", name: "Configured", createdAt: 1, updatedAt: 2 },
      });
      using anchor = new DatabaseSync(dbPath, { readOnly: true });
      const schema = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()?.schema;
      expect(schema).toMatch(/^configured_workboard_[0-9a-f]{16}$/);
      if (typeof schema !== "string") {
        throw new Error("Missing configured schema");
      }
      schemas.add(schema);
      expect(
        (await observer.query(`SELECT name FROM ${quoteIdentifier(schema)}.workboard_boards`)).rows,
      ).toEqual([{ name: "Configured" }]);
    } finally {
      await stores.close();
    }
  });

  it("refuses an unreachable configured server without creating SQLite workboard tables", async () => {
    const dbPath = databasePath();
    expect(() =>
      createWorkboardDatabase(dbPath, undefined, {
        connection: "postgresql://127.0.0.1:1/unreachable",
        schemaPrefix: "openclaw",
      }),
    ).toThrow(/database.postgres.connection.*server availability/);
    using anchor = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      anchor.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'workboard_%'").all(),
    ).toEqual([]);
  });

  it("retains a real SQLite anchor and reopens the same PostgreSQL schema", async () => {
    const dbPath = databasePath();
    const first = await openDatabase(dbPath);
    await first.fixture.statements(
      [
        {
          sql: "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          method: "run",
          args: ["board", "Persisted remotely", 1, 2],
        },
      ],
      true,
    );
    const persisted = await observer.query<{ name: string }>(
      `SELECT name FROM ${quoteIdentifier(first.schema)}.workboard_boards WHERE id = $1`,
      ["board"],
    );
    expect(persisted.rows).toEqual([{ name: "Persisted remotely" }]);
    const schema = first.schema;
    await first.close();
    const reopened = await openDatabase(dbPath);
    expect(reopened.schema).toBe(schema);
    expect(
      await reopened.fixture.statements([
        {
          sql: "SELECT name FROM workboard_boards WHERE id = ?",
          method: "get",
          args: ["board"],
        },
      ]),
    ).toEqual([{ name: "Persisted remotely" }]);
    await reopened.close();
    using anchor = new DatabaseSync(dbPath, { readOnly: true });
    expect(anchor.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(
      anchor.prepare("SELECT name FROM sqlite_schema WHERE name = 'workboard_boards'").get(),
    ).toBeUndefined();
  });

  it("publishes the anchor receipt after a PostgreSQL commit but not after rollback or failure", async () => {
    const dbPath = databasePath();
    const { fixture, schema } = await openDatabase(dbPath);
    const before = readSqliteDatabaseWriteTokenForPath(dbPath);
    expect(before).toBeDefined();
    await fixture.statements([insertBoard("committed")], true);
    const committed = readSqliteDatabaseWriteTokenForPath(dbPath);
    expect(committed).toBeDefined();
    expect(committed).not.toBe(before);
    expect(
      (
        await observer.query(
          `SELECT id FROM ${quoteIdentifier(schema)}.workboard_boards ORDER BY id`,
        )
      ).rows,
    ).toEqual([{ id: "committed" }]);
    await expect(
      fixture.statements([insertBoard("rolled-back")], true, "roll back this write"),
    ).rejects.toThrow("roll back this write");
    expect(readSqliteDatabaseWriteTokenForPath(dbPath)).toBe(committed);
    await expect(
      fixture.statements([insertBoard("failed"), insertBoard("committed")], true),
    ).rejects.toThrow("UNIQUE constraint failed");
    expect(readSqliteDatabaseWriteTokenForPath(dbPath)).toBe(committed);
    await expect(
      fixture.statements(
        [insertBoard("caught"), { ...insertBoard("committed"), catchError: true }],
        true,
      ),
    ).rejects.toThrow("rolled back instead of committing");
    expect(readSqliteDatabaseWriteTokenForPath(dbPath)).toBe(committed);
    expect(
      (
        await observer.query(
          `SELECT id FROM ${quoteIdentifier(schema)}.workboard_boards ORDER BY id`,
        )
      ).rows,
    ).toEqual([{ id: "committed" }]);
  });

  it.each([
    ["COMMIT", true],
    ["SELECT 1", false],
  ] as const)("classifies terminated PostgreSQL sessions before %s", async (statement, unknown) => {
    const dbPath = databasePath();
    const { fixture, schema } = await openDatabase(dbPath);
    const [process] = await fixture.statements([
      { sql: "SELECT pg_backend_pid() AS pid", method: "get" },
    ]);
    const pid = (process as { pid: number }).pid;
    expect(typeof pid).toBe("number");
    const token = readSqliteDatabaseWriteTokenForPath(dbPath);
    await fixture.statements([
      { sql: "BEGIN ISOLATION LEVEL READ COMMITTED" },
      insertBoard("discarded"),
    ]);
    const terminated = await observer.query<{ terminated: boolean }>(
      "SELECT pg_terminate_backend($1, 5000) AS terminated",
      [pid],
    );
    expect(terminated.rows).toEqual([{ terminated: true }]);
    const reply = await fixture.request({ kind: "statements", statements: [{ sql: statement }] });
    const message = unknown
      ? "PostgreSQL connection lost; outcome unknown"
      : "PostgreSQL connection lost; transaction rolled back";
    expect(() => unwrapWorkboardSqliteResult(reply.result)).toThrow(message);
    expect(reply.outcomeUnknown).toBe(unknown);
    expect((await fixture.state()).isOpen).toBe(false);
    expect(await fixture.execute({ kind: "assertClosed", sql: "SELECT 2" })).toEqual({
      sent: false,
      failure: message,
    });
    if (unknown) {
      expect(readSqliteDatabaseWriteTokenForPath(dbPath)).not.toBe(token);
    } else {
      expect(readSqliteDatabaseWriteTokenForPath(dbPath)).toBe(token);
    }
    expect(
      (await observer.query(`SELECT id FROM ${quoteIdentifier(schema)}.workboard_boards`)).rows,
    ).toEqual([]);
  });

  it("keeps the connection usable after a deferred constraint fails at COMMIT", async () => {
    const { fixture } = await openDatabase(databasePath());
    const [pid] = await fixture.statements([
      { sql: "SELECT pg_backend_pid() AS pid", method: "get" },
    ]);
    await fixture.statements([
      { sql: "CREATE TABLE deferred_unique (id INTEGER UNIQUE DEFERRABLE INITIALLY DEFERRED)" },
      { sql: "BEGIN" },
      { sql: "INSERT INTO deferred_unique VALUES (1), (1)" },
    ]);
    const reply = await fixture.request({ kind: "statements", statements: [{ sql: "COMMIT" }] });
    expect(reply.result.ok).toBe(false);
    if (!reply.result.ok) {
      expect(reply.result.failure).toMatchObject({
        code: "ERR_SQLITE_ERROR",
        errcode: 2067,
        cause: { code: "23505" },
      });
    }
    expect(reply.outcomeUnknown).toBe(false);
    expect(await fixture.state()).toMatchObject({ isTransaction: false, isOpen: true });
    expect(
      await fixture.statements([{ sql: "SELECT pg_backend_pid() AS pid", method: "get" }]),
    ).toEqual([pid]);
    await fixture.statements([{ sql: "INSERT INTO deferred_unique VALUES (2)" }], true);
    expect(
      await fixture.statements([{ sql: "SELECT id FROM deferred_unique", method: "all" }]),
    ).toEqual([[{ id: 2 }]]);
  });

  it("refuses a PostgreSQL anchor when the PostgreSQL config is absent without creating SQLite data", async () => {
    const dbPath = databasePath();
    const opened = await openDatabase(dbPath);
    const schema = opened.schema;
    await opened.fixture.statements(
      [
        {
          sql: "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          method: "run",
          args: ["remote", "Keep remote data", 1, 2],
        },
      ],
      true,
    );
    await opened.close();
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
    expect(() => createWorkboardDatabase(dbPath)).toThrow(schema);
    expect(() => createWorkboardDatabase(dbPath)).toThrow("database.engine");
    expect(snapshotAnchor()).toEqual(before);
    const reopened = await openDatabase(dbPath);
    expect(reopened.schema).toBe(schema);
    expect(
      await reopened.fixture.statements([
        {
          sql: "SELECT name FROM workboard_boards WHERE id = ?",
          method: "get",
          args: ["remote"],
        },
      ]),
    ).toEqual([{ name: "Keep remote data" }]);
  });

  // External metadata changes are visible on the next physical-store admission, not warm reopen.
  function replaceAnchorForFreshAdmission(dbPath: string) {
    fs.copyFileSync(dbPath, `${dbPath}.replacement`);
    fs.renameSync(`${dbPath}.replacement`, dbPath);
  }

  it("refuses a PostgreSQL schema version mismatch without migrating it", async () => {
    const dbPath = databasePath();
    const opened = await openDatabase(dbPath);
    const schema = opened.schema;
    await opened.close();
    await observer.query(
      `UPDATE ${quoteIdentifier(schema)}.openclaw_schema_meta SET version = 4 WHERE store = 'workboard'`,
    );
    replaceAnchorForFreshAdmission(dbPath);
    expect(() => createWorkboardDatabase(dbPath, undefined, postgresInput)).toThrow(/expected.*3/i);
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
    const opened = await openDatabase(dbPath);
    const schema = opened.schema;
    await opened.close();
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
    replaceAnchorForFreshAdmission(dbPath);
    expect(() => createWorkboardDatabase(dbPath, undefined, postgresInput)).toThrow(
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
    expect(() => createWorkboardDatabase(dbPath, undefined, postgresInput)).toThrow(
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
