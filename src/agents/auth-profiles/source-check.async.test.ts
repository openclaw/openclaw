import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState as State,
} from "../../test-utils/openclaw-test-state.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import { hasAnyAuthProfileStoreSourceAsync as hasSource } from "./source-check.js";
import { writeAuthProfileJsonCell } from "./sqlite-json-write.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import * as readers from "./sqlite-read.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";

async function prepareSourceCohort(state: State) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const sessionKey = "agent:main:auth-source";
  writeSessionEntry(database, sessionKey, { sessionId: "auth-source", updatedAt: 1 });
  const { databaseClaim } = await loadSessionEntryForAdmission({
    agentId: "main",
    env: state.env,
    storePath: database.path,
    sessionKey,
  });
  if (!("reader" in databaseClaim) || !databaseClaim.reader) {
    await databaseClaim.release();
    throw new Error("Expected an admitted auth-source cohort");
  }
  return {
    database,
    reader: databaseClaim.reader,
    [Symbol.asyncDispose]: () => databaseClaim.release(),
  };
}

async function expectSource(
  agentDir: string,
  expected: boolean,
  reader?: Parameters<typeof hasSource>[1],
  calibrate = false,
) {
  const sql = observeMainThreadSql();
  try {
    if (calibrate) {
      sql.calibrate();
    }
    expect(await hasSource(agentDir, reader)).toBe(expected);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

function withState(
  run: (state: State, database: (name: string, sql?: string) => string) => Promise<void>,
) {
  return withOpenClawTestState({ label: "auth-source" }, async (state) => {
    try {
      await run(state, (name, sql) => {
        const dir = state.agentDir(name);
        fs.mkdirSync(dir, { recursive: true });
        if (sql) {
          using database = new DatabaseSync(resolveAuthProfileDatabasePath(dir));
          database.exec(sql);
        }
        return dir;
      });
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
}

function sourceRow(table: "store" | "state", json: string) {
  return `CREATE TABLE auth_profile_${table} (${table}_key TEXT, ${table}_json TEXT);
    INSERT INTO auth_profile_${table} VALUES ('primary', '${json}')`;
}

it("retains read failure classification when cleanup fails", () =>
  withState(async (state) => {
    const failure = new SqliteWorkerError("source read closed", "closed");
    vi.spyOn(readers, "prepareAgentAuthProfileRowsRead").mockReturnValue({
      identity: undefined,
      source: { kind: "shared-state", databasePath: "/fixture/shared.sqlite" },
      captureCredentialAuthority: () => undefined,
      read: () => Promise.reject(failure),
      track: (operation) => operation,
      assertCurrent: () => {},
      dispose: () => Promise.reject(new Error("source cleanup failed")),
    });
    await expect(hasSource(state.agentDir("source"))).rejects.toMatchObject({
      code: "closed",
      cause: failure,
    });
  }));

it("detects an existing auth source without caller-thread SQLite", () =>
  withState(async (_state, database) => {
    const agentDir = database("source", sourceRow("store", '{"version":1,"profiles":{}}'));
    await expectSource(agentDir, true, undefined, true);
  }));

it("refreshes absent and malformed rows through the cohort", () =>
  withState(async (state) => {
    noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, state.env);
    await using cohort = await prepareSourceCohort(state);
    const { database, reader } = cohort;
    using peer = new DatabaseSync(database.path);
    using standalone = vi.spyOn(readers, "prepareAgentAuthProfileRowsRead");
    const cases = [
      ["state", undefined, false],
      ["state", "false", false],
      ["state", "{}", true],
      ["state", "{", false],
      ["store", "{", true],
      ["store", '{"version":1,"profiles":{}}', true],
    ] as const;
    for (const [table, json, expected] of cases) {
      peer.exec("DELETE FROM auth_profile_store; DELETE FROM auth_profile_state");
      if (json !== undefined) {
        peer.prepare(`INSERT INTO auth_profile_${table} VALUES ('primary', ?, 1)`).run(json);
      }
      await expectSource(state.agentDir(), expected, reader);
    }
    expect(
      standalone.mock.calls.filter(([input]) => input.databasePath === database.path),
    ).toHaveLength(0);
  }));

it("rejects cohort path, agent owner, and state root mismatches", () =>
  withState(async (state) => {
    await using cohort = await prepareSourceCohort(state);
    const { database, reader } = cohort;
    writeAuthProfileJsonCell(database.db, "store", "agent", { version: 1, profiles: {} });
    using readCohort = vi.spyOn(reader, "withRead");
    for (const changed of [
      { path: `${database.path}.other` },
      { agentId: "other" },
      { env: { ...reader.database.env, OPENCLAW_STATE_DIR: state.path("another-state-root") } },
    ]) {
      const mismatched = { ...reader, database: { ...reader.database, ...changed } };
      expect(await hasSource(state.agentDir(), mismatched)).toBe(true);
    }
    expect(readCohort).not.toHaveBeenCalled();
  }));

it("routes absent, missing-table, state-only, and unreadable sources", () =>
  withState(async (state, database) => {
    noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, state.env);
    const cases = [
      ["absent", false, ""],
      ["tables-missing", false, "CREATE TABLE unrelated (value TEXT)"],
      [
        "row-missing-state-broken",
        false,
        "CREATE TABLE auth_profile_store (store_key TEXT, store_json TEXT); CREATE TABLE auth_profile_state (wrong_column TEXT)",
      ],
      ["state-only", true, sourceRow("state", "{}")],
      ["false-state", false, sourceRow("state", "false")],
      ["unreadable-json", true, sourceRow("store", "{")],
      ["view-instead-of-table", true, "CREATE VIEW auth_profile_store AS SELECT 1"],
      ["unreadable-database", true, ""],
    ] as const;
    for (const [name, expected, sql] of cases) {
      const agentDir = database(name, sql);
      if (name === "unreadable-database") {
        fs.writeFileSync(resolveAuthProfileDatabasePath(agentDir), "not a SQLite database");
      }
      await expectSource(agentDir, expected);
    }
    expect(fs.existsSync(resolveAuthProfileDatabasePath(state.agentDir("absent")))).toBe(false);
  }));

it("keeps the captured shared root after a local read yields", () =>
  withState(async (state) => {
    writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
    const shared = openOpenClawStateDatabase();
    writeAuthProfileJsonCell(shared.db, "store", "shared-state", { version: 1, profiles: {} });
    const original = readers.prepareAgentAuthProfileRowsRead;
    vi.spyOn(readers, "prepareAgentAuthProfileRowsRead").mockImplementation((input) => {
      const reader = original(input);
      return {
        ...reader,
        read: async () => {
          const rows = await reader.read();
          vi.stubEnv("OPENCLAW_STATE_DIR", state.path("replacement-root"));
          return rows;
        },
      };
    });
    await expectSource(state.agentDir("absent"), true);
  }));
