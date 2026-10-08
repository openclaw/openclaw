import path from "node:path";
import { type DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import {
  closeRetainedOpenClawStateReadConnections,
  withOpenClawStateReadOnlyLocation,
} from "../../state/openclaw-state-db-read-connection.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { buildAcpDatabaseSessionKey, upsertAcpSessionMetaRow } from "./session-meta-keys.js";
import type { AcpSessionReadCommand } from "./session-meta-read.types.js";
import { readAcpSessionCommand } from "./session-meta-read.worker.js";
import { bindAcpSessionMeta } from "./session-meta-write.kernel.js";

const databases: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeRetainedOpenClawStateReadConnections();
    for (const db of databases.splice(0)) {
      if (db.isOpen) {
        db.close();
      }
    }
    cleanup();
  }),
);
const schema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "acp_sessions", {
  endMarker: "CREATE TABLE IF NOT EXISTS acp_replay_sessions",
  includeEndMarker: false,
});
const key = buildAcpDatabaseSessionKey("agent:main:acp:cache", "main");
const command = {
  type: "acpSessions.metadata",
  entries: [{ keys: [key], entry: { sessionId: "session", lifecycleRevision: "generation" } }],
} satisfies AcpSessionReadCommand;
function insert(db: DatabaseSync, name: string) {
  upsertAcpSessionMetaRow(
    db,
    bindAcpSessionMeta({
      sessionKey: key,
      lifecycleRevision: "generation",
      updatedAt: 100,
      meta: {
        backend: "fixture",
        agent: "main",
        runtimeSessionName: name,
        mode: "persistent",
        state: "idle",
        lastActivityAt: 100,
      },
    }),
  );
}
function fixture() {
  const pathname = path.join(tempDirs.make("openclaw-acp-read-cache-"), "state.sqlite");
  const writer = openNodeSqliteDatabase(pathname);
  databases.push(writer);
  writer.exec(`PRAGMA journal_mode=WAL; ${schema}`);
  const read = (input: AcpSessionReadCommand = command) =>
    withOpenClawStateReadOnlyLocation(
      ({ db }) => readAcpSessionCommand(db, input),
      pathname,
      pathname,
      undefined,
      undefined,
      undefined,
      true,
    );
  return { writer, pathname, read };
}

it("reuses admitted ACP rows while observing foreign inserts, updates and deletion on the next read", () => {
  const { writer, read } = fixture();
  expect(read().rows).toEqual([null]);
  expect(read().rows).toEqual([null]);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  const metadataReads = () =>
    observation.queries.filter((sql) => /from "acp_sessions"/iu.test(sql));
  try {
    expect(read().rows).toEqual([null]);
    expect(read().rows).toEqual([null]);
    expect(metadataReads()).toHaveLength(0);
    insert(writer, "first");
    expect(read().rows[0]).toMatchObject({ runtime_session_name: "first" });
    expect(metadataReads()).toHaveLength(1);
    const rows = read().rows;
    expect(rows[0]).toMatchObject({ runtime_session_name: "first" });
    if (rows[0] && "runtime_session_name" in rows[0]) {
      rows[0].runtime_session_name = "caller-mutated";
    }
    expect(read().rows[0]).toMatchObject({ runtime_session_name: "first" });
    expect(
      read({ ...command, entries: [{ keys: [key], entry: { sessionId: "successor" } }] }).rows,
    ).toEqual([null]);
    expect(metadataReads()).toHaveLength(1);
    writer.prepare("UPDATE acp_sessions SET runtime_session_name = 'second'").run();
    expect(read().rows[0]).toMatchObject({ runtime_session_name: "second" });
    writer.prepare("DELETE FROM acp_sessions").run();
    expect(read().rows).toEqual([null]);
    expect(metadataReads()).toHaveLength(3);
  } finally {
    observation.restore();
  }
});

it("keeps a pinned ACP snapshot and refreshes after it closes", () => {
  const { writer, pathname, read } = fixture();
  insert(writer, "before");
  expect(read().rows[0]).toMatchObject({ runtime_session_name: "before" });
  withOpenClawStateReadOnlyLocation(
    ({ db }) => {
      db.exec("BEGIN");
      try {
        expect(readAcpSessionCommand(db, command).rows[0]).toMatchObject({
          runtime_session_name: "before",
        });
        writer.prepare("UPDATE acp_sessions SET runtime_session_name = 'after'").run();
        expect(readAcpSessionCommand(db, command).rows[0]).toMatchObject({
          runtime_session_name: "before",
        });
      } finally {
        db.exec("COMMIT");
      }
    },
    pathname,
    pathname,
    undefined,
    undefined,
    undefined,
    true,
  );
  expect(read().rows[0]).toMatchObject({ runtime_session_name: "after" });
});

it("invalidates admitted ACP rows after local native writes and reader retirement", () => {
  const { writer, read } = fixture();
  insert(writer, "initial");
  admitSqliteSchema(writer);
  const localRead = () =>
    runSqliteReadOperationSync(writer, () => readAcpSessionCommand(writer, command));
  expect(localRead().rows[0]).toMatchObject({ runtime_session_name: "initial" });
  writer.prepare("UPDATE acp_sessions SET runtime_session_name = 'local'").run();
  expect(localRead().rows[0]).toMatchObject({ runtime_session_name: "local" });
  expect(read().rows[0]).toMatchObject({ runtime_session_name: "local" });
  closeRetainedOpenClawStateReadConnections();
  writer.prepare("UPDATE acp_sessions SET runtime_session_name = 'reopened'").run();
  expect(read().rows[0]).toMatchObject({ runtime_session_name: "reopened" });
});
