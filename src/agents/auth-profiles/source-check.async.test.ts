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
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import { hasAnyAuthProfileStoreSourceAsync } from "./source-check.js";
import { SHARED_AUTH_STORE_STATE_KEY, writeAuthProfileJsonCell } from "./sqlite-json.js";
import * as readers from "./sqlite-read.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";

async function prepareSourceCohort(state: OpenClawTestState) {
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
  return { database, claim: databaseClaim, reader: databaseClaim.reader };
}

it("retains the read failure classification when reader cleanup also fails", async () => {
  await withOpenClawTestState({ label: "auth-source-cleanup" }, async (state) => {
    const failure = new SqliteWorkerError("source read closed", "closed");
    const prepare = vi.spyOn(readers, "prepareAgentAuthProfileRowsRead").mockReturnValue({
      identity: undefined,
      read: async () => {
        throw failure;
      },
      assertCurrent: () => {},
      dispose: async () => {
        throw new Error("source cleanup failed");
      },
    });
    try {
      await expect(
        hasAnyAuthProfileStoreSourceAsync(state.agentDir("source")),
      ).rejects.toMatchObject({
        code: "closed",
        cause: failure,
      });
    } finally {
      prepare.mockRestore();
    }
  });
});

it("detects an existing auth source without caller-thread SQLite", async () => {
  await withOpenClawTestState({ label: "auth-source-boundary" }, async (state) => {
    const agentDir = state.agentDir("source");
    fs.mkdirSync(agentDir, { recursive: true });
    const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
    database.exec(`
      CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
      INSERT INTO auth_profile_store VALUES ('primary', '{"version":1,"profiles":{}}');
    `);
    database.close();
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      expect(await hasAnyAuthProfileStoreSourceAsync(agentDir)).toBe(true);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("reads source presence through the selected cohort and refreshes foreign absence and malformed rows", async () => {
  await withOpenClawTestState({ label: "auth-source-cohort" }, async (state) => {
    noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, state.env);
    const { database, claim, reader } = await prepareSourceCohort(state);
    const peer = new DatabaseSync(database.path);
    const standalone = vi.spyOn(readers, "prepareAgentAuthProfileRowsRead");
    const cases = [
      { expected: false },
      { state: "false", expected: false },
      { state: "{}", expected: true },
      { state: "{", expected: false },
      { store: "{", expected: true },
      { store: "null", expected: true },
      { store: '{"version":1,"profiles":{}}', expected: true },
      { expected: false },
    ];
    try {
      for (const fixture of cases) {
        peer.exec("DELETE FROM auth_profile_store; DELETE FROM auth_profile_state");
        if (fixture.store !== undefined) {
          peer
            .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)")
            .run(fixture.store);
        }
        if (fixture.state !== undefined) {
          peer
            .prepare("INSERT INTO auth_profile_state VALUES ('primary', ?, 1)")
            .run(fixture.state);
        }
        const sql = observeMainThreadSql();
        try {
          expect(await hasAnyAuthProfileStoreSourceAsync(state.agentDir(), reader)).toBe(
            fixture.expected,
          );
          sql.expectIdle();
        } finally {
          sql.restore();
        }
      }
      expect(
        standalone.mock.calls.filter(([input]) => input.databasePath === database.path),
      ).toHaveLength(0);
    } finally {
      standalone.mockRestore();
      peer.close();
      await claim.release();
    }
  });
});

it("keeps mismatched cohort paths, agent owners, and state roots on the original auth reader", async () => {
  await withOpenClawTestState({ label: "auth-source-cohort-scope" }, async (state) => {
    const { database, claim, reader } = await prepareSourceCohort(state);
    writeAuthProfileJsonCell(database.db, "store", "agent", { version: 1, profiles: {} });
    const readCohort = vi.spyOn(reader, "withRead");
    const standalone = vi.spyOn(readers, "prepareAgentAuthProfileRowsRead");
    try {
      for (const changed of [
        { path: `${database.path}.other` },
        { agentId: "other" },
        { env: { ...reader.database.env, OPENCLAW_STATE_DIR: state.path("another-state-root") } },
      ]) {
        const mismatched = { ...reader, database: { ...reader.database, ...changed } };
        expect(await hasAnyAuthProfileStoreSourceAsync(state.agentDir(), mismatched)).toBe(true);
      }
      expect(readCohort).not.toHaveBeenCalled();
      expect(
        standalone.mock.calls.filter(([input]) => input.databasePath === database.path),
      ).toHaveLength(3);
    } finally {
      standalone.mockRestore();
      readCohort.mockRestore();
      await claim.release();
    }
  });
});

it("preserves absent, table-missing, state-only, and unreadable source routing", async () => {
  await withOpenClawTestState({ label: "auth-source-routing" }, async (state) => {
    noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, state.env);
    const cases = [
      { name: "absent", expected: false },
      { name: "tables-missing", sql: "CREATE TABLE unrelated (value TEXT)", expected: false },
      {
        name: "row-missing-state-broken",
        sql: "CREATE TABLE auth_profile_store (store_key TEXT, store_json TEXT); CREATE TABLE auth_profile_state (wrong_column TEXT)",
        expected: false,
      },
      {
        name: "state-only",
        sql: "CREATE TABLE auth_profile_state (state_key TEXT, state_json TEXT); INSERT INTO auth_profile_state VALUES ('primary', '{}')",
        expected: true,
      },
      {
        name: "false-state",
        sql: "CREATE TABLE auth_profile_state (state_key TEXT, state_json TEXT); INSERT INTO auth_profile_state VALUES ('primary', 'false')",
        expected: false,
      },
      {
        name: "unreadable-json",
        sql: "CREATE TABLE auth_profile_store (store_key TEXT, store_json TEXT); INSERT INTO auth_profile_store VALUES ('primary', '{')",
        expected: true,
      },
      {
        name: "view-instead-of-table",
        sql: "CREATE VIEW auth_profile_store AS SELECT 1",
        expected: true,
      },
      { name: "unreadable-database", bytes: "not a SQLite database", expected: true },
    ];
    for (const fixture of cases) {
      const agentDir = state.agentDir(fixture.name);
      fs.mkdirSync(agentDir, { recursive: true });
      const databasePath = resolveAuthProfileDatabasePath(agentDir);
      if (fixture.sql) {
        const database = new DatabaseSync(databasePath);
        database.exec(fixture.sql);
        database.close();
      } else if (fixture.bytes) {
        fs.writeFileSync(databasePath, fixture.bytes);
      }
      const sql = observeMainThreadSql();
      try {
        expect(await hasAnyAuthProfileStoreSourceAsync(agentDir), fixture.name).toBe(
          fixture.expected,
        );
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    }
    expect(fs.existsSync(resolveAuthProfileDatabasePath(state.agentDir("absent")))).toBe(false);
  });
});

it("keeps inherited shared reads on the captured root after a local read yields", async () => {
  await withOpenClawTestState({ label: "auth-source-shared" }, async (state) => {
    writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
    const shared = openOpenClawStateDatabase();
    writeAuthProfileJsonCell(shared.db, "store", "shared-state", { version: 1, profiles: {} });
    const original = readers.prepareAgentAuthProfileRowsRead;
    const prepare = vi
      .spyOn(readers, "prepareAgentAuthProfileRowsRead")
      .mockImplementation((input) => {
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
    const sql = observeMainThreadSql();
    try {
      expect(await hasAnyAuthProfileStoreSourceAsync(state.agentDir("absent"))).toBe(true);
      sql.expectIdle();
    } finally {
      sql.restore();
      prepare.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
