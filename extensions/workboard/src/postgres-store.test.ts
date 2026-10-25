import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openEngineStore,
  withEngineStoreAdmission,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { readSqliteDatabaseWriteTokenForPath } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { Client, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { unwrapWorkboardSqliteResult } from "./sqlite-store-errors.js";
import { createWorkboardDatabase } from "./sqlite-store-schema.js";
import { workboardEngineSchema } from "./store-engine-schema.js";
import { workboardTestDatabaseInput } from "./test/database-config.js";
import { openPostgresFixture } from "./test/postgres-fixture.js";
import { SCHEMA_VERSION } from "./workboard-schema.js";

const postgresInput = workboardTestDatabaseInput();
const postgresUrl = postgresInput?.connection;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!postgresUrl)("experimental PostgreSQL workboard admission and receipts", () => {
  const observer = new Client({ connectionString: postgresUrl });
  const owners: Array<{ close: () => Promise<void> }> = [];
  const schemas = new Set<string>();

  beforeAll(() => observer.connect());

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

  afterAll(() => observer.end());

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

  const insertBoard = (id: string, name: string | null = null) => ({
    sql: "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    method: "run" as const,
    args: [id, name, 1, 2],
  });

  const get = (sql: string, args: string[] = []) => ({ sql, args, method: "get" as const });
  async function rows<Row extends QueryResultRow = QueryResultRow>(sql: string, args?: string[]) {
    return (await observer.query<Row>(sql, args)).rows;
  }
  async function boardIds(schema: string) {
    return await rows(`SELECT id FROM ${quoteIdentifier(schema)}.workboard_boards ORDER BY id`);
  }
  async function readName(
    fixture: Awaited<ReturnType<typeof openDatabase>>["fixture"],
    id: string,
  ) {
    return await fixture.statements([get("SELECT name FROM workboard_boards WHERE id = ?", [id])]);
  }

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

  it("invalidates anchor revisions for attempted writes while retaining only committed rows", async () => {
    const dbPath = databasePath();
    const { fixture, schema } = await openDatabase(dbPath);
    const before = readSqliteDatabaseWriteTokenForPath(dbPath);
    expect(before).toBeDefined();
    await fixture.statements([insertBoard("committed")], true);
    const committed = readSqliteDatabaseWriteTokenForPath(dbPath);
    expect(committed).toBeDefined();
    expect(committed).not.toBe(before);
    expect(await boardIds(schema)).toEqual([{ id: "committed" }]);
    await expect(
      fixture.statements([insertBoard("rolled-back")], true, "roll back this write"),
    ).rejects.toThrow("roll back this write");
    const rolledBack = readSqliteDatabaseWriteTokenForPath(dbPath);
    expect(rolledBack).not.toBe(committed);
    await expect(
      fixture.statements([insertBoard("failed"), insertBoard("committed")], true),
    ).rejects.toThrow("UNIQUE constraint failed");
    const failed = readSqliteDatabaseWriteTokenForPath(dbPath);
    expect(failed).not.toBe(rolledBack);
    await expect(
      fixture.statements(
        [insertBoard("caught"), { ...insertBoard("committed"), catchError: true }],
        true,
      ),
    ).rejects.toThrow("rolled back instead of committing");
    expect(readSqliteDatabaseWriteTokenForPath(dbPath)).not.toBe(failed);
    expect(await boardIds(schema)).toEqual([{ id: "committed" }]);
  });

  it.each([
    ["COMMIT", true],
    ["SELECT 1", false],
  ] as const)("classifies terminated PostgreSQL sessions before %s", async (statement, unknown) => {
    const dbPath = databasePath();
    const { fixture, schema } = await openDatabase(dbPath);
    const [process] = await fixture.statements([get("SELECT pg_backend_pid() AS pid")]);
    const pid = (process as { pid: number }).pid;
    const token = readSqliteDatabaseWriteTokenForPath(dbPath);
    await fixture.statements([
      { sql: "BEGIN ISOLATION LEVEL READ COMMITTED" },
      insertBoard("discarded"),
    ]);
    await observer.query("SELECT pg_terminate_backend($1, 5000) AS terminated", [pid]);
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
    // Like SQLite, attempted writes keep their cache witness even after a known rollback.
    expect(readSqliteDatabaseWriteTokenForPath(dbPath)).not.toBe(token);
    expect(await rows(`SELECT id FROM ${quoteIdentifier(schema)}.workboard_boards`)).toEqual([]);
  });

  it("keeps the connection usable after a deferred constraint fails at COMMIT", async () => {
    const { fixture } = await openDatabase(databasePath());
    const [pid] = await fixture.statements([get("SELECT pg_backend_pid() AS pid")]);
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
    expect(await fixture.statements([get("SELECT pg_backend_pid() AS pid")])).toEqual([pid]);
    await fixture.statements([{ sql: "INSERT INTO deferred_unique VALUES (2)" }], true);
    expect(
      await fixture.statements([{ sql: "SELECT id FROM deferred_unique", method: "all" }]),
    ).toEqual([[{ id: 2 }]]);
  });

  it("refuses a PostgreSQL anchor when the PostgreSQL config is absent without creating SQLite data", async () => {
    const dbPath = databasePath();
    const opened = await openDatabase(dbPath);
    const schema = opened.schema;
    await opened.fixture.statements([insertBoard("remote", "Keep remote data")], true);
    expect(await rows(`SELECT name FROM ${quoteIdentifier(schema)}.workboard_boards`)).toEqual([
      { name: "Keep remote data" },
    ]);
    await opened.close();
    const snapshotAnchor = () => {
      using anchor = new DatabaseSync(dbPath, { readOnly: true });
      return {
        schema: anchor.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
        rows: anchor.prepare("SELECT * FROM openclaw_engine_anchor").all(),
      };
    };
    const before = snapshotAnchor();
    expect(() => createWorkboardDatabase(dbPath)).toThrow(schema);
    expect(() => createWorkboardDatabase(dbPath)).toThrow("database.families.workboard.engine");
    expect(snapshotAnchor()).toEqual(before);
    const reopened = await openDatabase(dbPath);
    expect(reopened.schema).toBe(schema);
    expect(await readName(reopened.fixture, "remote")).toEqual([{ name: "Keep remote data" }]);
    await reopened.close();
    using anchor = new DatabaseSync(dbPath, { readOnly: true });
    expect(anchor.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(
      anchor.prepare("SELECT name FROM sqlite_schema WHERE name = 'workboard_boards'").get(),
    ).toBeUndefined();
  });

  // External metadata changes are visible on the next physical-store admission, not warm reopen.
  function replaceAnchorForFreshAdmission(dbPath: string) {
    fs.copyFileSync(dbPath, `${dbPath}.replacement`);
    fs.renameSync(`${dbPath}.replacement`, dbPath);
  }

  it("upgrades version 3 index ordering once while retaining board rows and nullable indexes", async () => {
    const dbPath = databasePath();
    const schema = withEngineStoreAdmission(() => {
      using anchor = new DatabaseSync(dbPath);
      const db = openEngineStore({
        anchor,
        input: postgresInput,
        schema: {
          ...workboardEngineSchema,
          ...workboardEngineSchema.postgresMigrations![0]!.fromSchema,
          version: 3,
        },
        prepareAnchor: () => {},
        inspectSqlite: () => ({ hasEngineAnchor: false, hasExistingData: false }),
        openSqlite: () => {},
      });
      try {
        db.prepare(
          "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).run("retained", "Retained board", 1, 2);
        return String(anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()?.schema);
      } finally {
        db.close();
      }
    });
    schemas.add(schema);
    const indexRows = () =>
      rows<{ name: string; oid: string; definition: string }>(
        `SELECT relname AS name, oid::text, pg_get_indexdef(oid) AS definition
       FROM pg_class WHERE relnamespace = $1::regnamespace
       AND relname IN ('workboard_cards_board_status_idx', 'workboard_cards_session_idx')
       ORDER BY relname`,
        [schema],
      );
    const before = await indexRows();
    const upgraded = await openDatabase(dbPath);
    await upgraded.close();
    const after = await indexRows();
    expect(after[0]!.definition).not.toContain("NULLS FIRST");
    expect(after[0]!.oid).not.toBe(before[0]!.oid);
    expect(after[1]).toEqual(before[1]);
    expect(await rows(`SELECT name FROM ${quoteIdentifier(schema)}.workboard_boards`)).toEqual([
      { name: "Retained board" },
    ]);
    expect(
      await rows(`SELECT version::integer FROM ${quoteIdentifier(schema)}.openclaw_schema_meta`),
    ).toEqual([{ version: SCHEMA_VERSION }]);
    await (await openDatabase(dbPath)).close();
    expect(await indexRows()).toEqual(after);
  });

  it.each(["version", "store_id"] as const)(
    "refuses mismatched PostgreSQL %s without changing metadata",
    async (field) => {
      const dbPath = databasePath();
      const { schema, close } = await openDatabase(dbPath);
      await close();
      const table = `${quoteIdentifier(schema)}.openclaw_schema_meta`;
      const read = () =>
        rows<{ value: string }>(
          `SELECT ${field}::text AS value FROM ${table} WHERE store = 'workboard'`,
        );
      const before = await read();
      expect(before).toHaveLength(1);
      const replacement =
        field === "version" ? String(SCHEMA_VERSION + 1) : "00000000-0000-4000-8000-000000000001";
      await observer.query(`UPDATE ${table} SET ${field} = $1 WHERE store = 'workboard'`, [
        replacement,
      ]);
      replaceAnchorForFreshAdmission(dbPath);
      expect(() => createWorkboardDatabase(dbPath, undefined, postgresInput)).toThrow(
        field === "version"
          ? new RegExp(`expected.*${SCHEMA_VERSION}`, "i")
          : new RegExp(`${before[0]!.value}.*${replacement}|${replacement}.*${before[0]!.value}`),
      );
      expect(await read()).toEqual([{ value: replacement }]);
    },
  );
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
