import path from "node:path";
import { type DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { AdmissionOperations } from "../../infra/sqlite-database-admission.worker.test-support.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { SqliteWorkerBroker } from "../../infra/sqlite-worker-broker.js";
import {
  closeRetainedOpenClawStateReadConnections,
  withOpenClawStateReadOnlyLocation,
} from "../../state/openclaw-state-db-read-connection.js";
import { assertSupportedStateSchemaVersion } from "../../state/openclaw-state-db-schema-version.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { buildAcpDatabaseSessionKey, upsertAcpSessionMetaRow } from "./session-meta-keys.js";
import type { AcpSessionReadCommand } from "./session-meta-read.types.js";
import {
  prepareAcpSessionMetadataRead,
  readAcpSessionCommand,
} from "./session-meta-read.worker.js";
import { applyAcpSessionMutation, bindAcpSessionMeta } from "./session-meta-write.kernel.js";

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
  writer.exec(`PRAGMA journal_mode=WAL; ${schema}
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);`);
  const read = (input: AcpSessionReadCommand = command) => {
    const metadata =
      input.type === "acpSessions.metadata" ? prepareAcpSessionMetadataRead(input) : undefined;
    return withOpenClawStateReadOnlyLocation(
      ({ db }) => (metadata ? metadata.read(db) : readAcpSessionCommand(db, input)),
      pathname,
      pathname,
      undefined,
      undefined,
      undefined,
      true,
      metadata?.readContentVersionRow,
    );
  };
  return { writer, pathname, read };
}

it("reuses admitted ACP rows until writer-worker settlement without freshness probes", async () => {
  const { writer, pathname, read } = fixture();
  const broker = new SqliteWorkerBroker();
  expect(read().rows).toEqual([null]);
  expect(read().rows).toEqual([null]);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  const metadataReads = () =>
    observation.queries.filter((sql) => /(?:from|join) "acp_sessions"/iu.test(sql));
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
    const store = await broker.open<AdmissionOperations>({
      moduleUrl: new URL(
        "../../infra/sqlite-database-admission.worker.test-support.ts",
        import.meta.url,
      ),
      databasePath: pathname,
      input: undefined,
    });
    const mutate = (sql: string) =>
      broker.runOperation(store!, (scope) =>
        scope.execute({
          type: "writeRows",
          input: { sql },
        }),
      );
    await mutate("UPDATE acp_sessions SET runtime_session_name = 'second'");
    expect(read().rows[0]).toMatchObject({ runtime_session_name: "second" });
    await mutate("DELETE FROM acp_sessions");
    expect(read().rows).toEqual([null]);
    expect(metadataReads()).toHaveLength(3);
    expect(observation.queries.filter((sql) => /data_version/iu.test(sql))).toEqual([]);
  } finally {
    observation.restore();
    await broker.close();
  }
});

it("keeps a pinned ACP snapshot and refreshes after it closes", () => {
  const { writer, pathname, read } = fixture();
  insert(writer, "before");
  expect(read().rows[0]).toMatchObject({ runtime_session_name: "before" });
  withOpenClawStateReadOnlyLocation(
    ({ db }) => {
      db.exec("BEGIN");
      const readPinned = () => {
        const metadata = prepareAcpSessionMetadataRead(command);
        return runSqliteReadOperationSync(db, () => {
          assertSupportedStateSchemaVersion(
            db,
            pathname,
            undefined,
            metadata.readContentVersionRow,
          );
          return metadata.read(db);
        });
      };
      try {
        expect(readPinned().rows[0]).toMatchObject({
          runtime_session_name: "before",
        });
        writer.prepare("UPDATE acp_sessions SET runtime_session_name = 'after'").run();
        expect(readPinned().rows[0]).toMatchObject({
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

it("publishes decoded set and clear postimages without rereading metadata after either write", () => {
  const { writer, read } = fixture();
  const input = {
    agentId: "main",
    storageSessionKey: "agent:main:acp:cache",
    sessionKey: "agent:main:acp:cache",
    entry: { sessionId: "session", lifecycleRevision: "generation", updatedAt: 200 },
  };
  const meta: SessionAcpMeta = {
    backend: "fixture",
    agent: "main",
    runtimeSessionName: "returned-row",
    mode: "persistent",
    state: "error",
    lastActivityAt: 200,
    identity: {
      state: "resolved",
      source: "status",
      agentSessionId: "synthetic-agent-session",
      lastUpdatedAt: 200,
    },
    cwd: "/synthetic/workspace",
    runtimeOptions: { model: "fixture-model" },
    lastError: "synthetic error",
  };
  const counter = trackSqliteStatementExecutions(writer, ["read", "write"], (sql) => {
    if (!/\bacp_sessions\b/iu.test(sql)) {
      return null;
    }
    return /^select\b/iu.test(sql) ? "read" : "write";
  });
  try {
    expect(applyAcpSessionMutation(writer, { ...input, decision: { kind: "set", meta } })).toEqual({
      kind: "acp",
      sessionId: "session",
      lifecycleRevision: "generation",
      sessionStartedAt: undefined,
      acp: meta,
    });
    expect(read().rows[0]).toMatchObject({
      runtime_session_name: "returned-row",
      runtime_options_json: JSON.stringify(meta.runtimeOptions),
      last_error: meta.lastError,
    });
    expect(applyAcpSessionMutation(writer, { ...input, decision: { kind: "clear" } })).toEqual({
      kind: "acp",
      sessionId: "session",
      lifecycleRevision: "generation",
      sessionStartedAt: undefined,
      acp: null,
    });
    expect(counter.counts).toEqual({ read: 0, write: 2 });
    expect(read().rows).toEqual([null]);
  } finally {
    counter.restore();
  }
});
