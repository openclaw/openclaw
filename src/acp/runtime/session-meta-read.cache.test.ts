import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import {
  closeRetainedOpenClawStateReadConnections,
  withOpenClawStateReadOnlyLocation,
} from "../../state/openclaw-state-db-read-connection.js";
import { assertSupportedStateSchemaVersion } from "../../state/openclaw-state-db-schema-version.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import {
  buildAcpDatabaseSessionKey,
  readPublishedAcpSessionRows,
  upsertAcpSessionMetaRow,
} from "./session-meta-keys.js";
import { createAcpMeta } from "./session-meta-lifecycle.test-support.js";
import type { AcpSessionReadCommand } from "./session-meta-read.types.js";
import {
  prepareAcpSessionMetadataRead,
  readAcpSessionCommand,
} from "./session-meta-read.worker.js";
import { applyAcpSessionMutation, bindAcpSessionMeta } from "./session-meta-write.kernel.js";

const databases: DatabaseSync[] = [];
const restorers: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    restorers.splice(0).forEach((restore) => restore());
    closeRetainedOpenClawStateReadConnections();
    for (const db of databases.splice(0).filter((database) => database.isOpen)) {
      db.close();
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
      meta: createAcpMeta({ runtimeSessionName: name }),
    }),
  );
}
function expectName(row: unknown, name: string) {
  expect(row).toMatchObject({ runtime_session_name: name });
}
function fixture() {
  const pathname = path.join(tempDirs.make("openclaw-acp-read-cache-"), "state.sqlite");
  const writer = openNodeSqliteDatabase(pathname);
  databases.push(writer);
  writer.exec(`PRAGMA journal_mode=WAL; ${schema}
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);`);
  const readerLocation = [pathname, pathname, undefined, undefined, undefined, true] as const;
  const withReader = <T>(
    run: Parameters<typeof withOpenClawStateReadOnlyLocation<T>>[0],
    admission?: Parameters<typeof withOpenClawStateReadOnlyLocation>[7],
  ) => withOpenClawStateReadOnlyLocation(run, ...readerLocation, admission);
  const read = (
    input: Extract<AcpSessionReadCommand, { type: "acpSessions.metadata" }> = command,
  ) => {
    const metadata = prepareAcpSessionMetadataRead(input);
    return withReader(({ db }) => metadata.read(db), metadata.readContentVersionRow);
  };
  return { writer, pathname, read, withReader };
}

it("keeps a pinned ACP snapshot and refreshes after it closes", () => {
  const { writer, pathname, read, withReader } = fixture();
  insert(writer, "before");
  expectName(read().rows[0], "before");
  withReader(({ db }) => {
    db.exec("BEGIN");
    const readPinned = () => {
      const metadata = prepareAcpSessionMetadataRead(command);
      return runSqliteReadOperationSync(db, () => {
        assertSupportedStateSchemaVersion(db, pathname, undefined, metadata.readContentVersionRow);
        return metadata.read(db);
      });
    };
    try {
      expectName(readPinned().rows[0], "before");
      insert(writer, "after");
      expectName(readPinned().rows[0], "before");
      expectName(readPublishedAcpSessionRows(pathname, command.entries)?.[0], "after");
    } finally {
      db.exec("COMMIT");
    }
  });
  expectName(read().rows[0], "after");
});

it("invalidates admitted ACP rows after local native writes and reader retirement", () => {
  const { writer, read } = fixture();
  insert(writer, "initial");
  admitSqliteSchema(writer);
  const localRead = () =>
    runSqliteReadOperationSync(writer, () => readAcpSessionCommand(writer, command));
  expectName(localRead().rows[0], "initial");
  insert(writer, "local");
  expectName(localRead().rows[0], "local");
  expectName(read().rows[0], "local");
  closeRetainedOpenClawStateReadConnections();
  insert(writer, "reopened");
  expectName(read().rows[0], "reopened");
});

it("publishes decoded set and clear postimages without rereading metadata after either write", () => {
  const { writer, pathname, read } = fixture();
  const input = {
    agentId: "main",
    storageSessionKey: "agent:main:acp:cache",
    sessionKey: "agent:main:acp:cache",
    entry: { ...command.entries[0]!.entry, updatedAt: 200 },
  };
  const result = { kind: "acp", ...command.entries[0]!.entry, sessionStartedAt: undefined };
  const meta = createAcpMeta({
    runtimeSessionName: "returned-row",
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
  });
  const counter = trackSqliteStatementExecutions(writer, ["read", "write"], (sql) => {
    if (!/\bacp_sessions\b/iu.test(sql)) {
      return null;
    }
    return /^select\b/iu.test(sql) ? "read" : "write";
  });
  restorers.push(counter.restore);
  const mutate = (decision: Parameters<typeof applyAcpSessionMutation>[1]["decision"]) =>
    applyAcpSessionMutation(writer, { ...input, decision });
  expect(mutate({ kind: "set", meta })).toEqual({ ...result, acp: meta });
  const row = read().rows[0];
  expect(row).toMatchObject({
    runtime_session_name: "returned-row",
    runtime_options_json: JSON.stringify(meta.runtimeOptions),
    last_error: meta.lastError,
  });
  if (row && "runtime_session_name" in row) {
    row.runtime_session_name = "caller-mutated";
  }
  expectName(read().rows[0], "returned-row");
  expect(
    read({ ...command, entries: [{ keys: [key], entry: { sessionId: "successor" } }] }).rows,
  ).toEqual([null]);
  expect(mutate({ kind: "clear" })).toEqual({ ...result, acp: null });
  expect(counter.counts).toEqual({ read: 0, write: 2 });
  expect(read().rows).toEqual([null]);
  expect(readPublishedAcpSessionRows(pathname, command.entries)).toEqual([null]);
});
