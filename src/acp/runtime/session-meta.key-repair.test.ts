import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { withDoctorSqliteMaintenanceLock } from "../../commands/doctor-sqlite-maintenance-lock.js";
import {
  loadExactSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../../config/sessions/session-accessor.sqlite-participants.native.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import * as snapshots from "../../infra/sqlite-snapshot.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { repairAcpSessionMetaKeysForDoctor } from "./session-meta-doctor.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { createAcpMeta } from "./session-meta-lifecycle.test-support.js";
import { readAcpSessionMetaForEntry } from "./session-meta-readonly.js";
import { readAcpSessionEntry, writeAcpSessionMetaForMigration } from "./session-meta.js";

const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
const key = "agent:harness:acp:key-repair";
const alias = "agent:HARNESS:acp:key-repair";
const entry = {
  sessionId: "key-repair-session",
  lifecycleRevision: "key-repair-revision",
  sessionStartedAt: 50,
  updatedAt: 100,
};
const meta = createAcpMeta({ agent: "harness" });
const noRepairs = { found: 0, repaired: 0, warnings: [] };
const repaired = { found: 1, repaired: 1, warnings: [], backups: [expect.any(String)] };
const withState = (run: (state: OpenClawTestState) => Promise<void>) =>
  withOpenClawTestState({ scenario: "empty" }, run);
const retained = (warning: string) => ({
  repaired: 0,
  warnings: [expect.stringContaining(warning)],
});
const rows = (db: EngineConnection, table = "acp_sessions") =>
  db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
const sourceRow = (db: EngineConnection, sessionKey: string) =>
  db.prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?").get(sessionKey);

function expectBackup(file: string, check: (db: DatabaseSync) => void) {
  using backup = new DatabaseSync(file, { readOnly: true });
  check(backup);
}

const bind = (env: NodeJS.ProcessEnv, sessionKey = key, agentId = "harness") =>
  replaceSessionEntrySync({ agentId, sessionKey, env }, entry);

type RepairOptions = Partial<Parameters<typeof repairAcpSessionMetaKeysForDoctor>[0]>;
const repair = (env: NodeJS.ProcessEnv, options: RepairOptions = {}) =>
  repairAcpSessionMetaKeysForDoctor({
    cfg,
    env,
    apply: true,
    authority: { assertCurrent() {} },
    ...options,
  });

type MigrationOptions = Partial<Parameters<typeof writeAcpSessionMetaForMigration>[0]>;
const seed = (env: NodeJS.ProcessEnv, sessionKey: string, options: MigrationOptions = {}) =>
  writeAcpSessionMetaForMigration({
    env,
    sessionKey,
    lifecycleRevision: entry.lifecycleRevision,
    meta,
    now: () => 100,
    ...options,
  });

it.each([
  { source: key, binding: entry.lifecycleRevision, conflicting: true },
  { source: alias, binding: undefined, conflicting: false },
])(
  "repairs $source (binding=$binding, conflicting=$conflicting)",
  ({ source, binding, conflicting }) =>
    withState(async ({ env, stateDir }) => {
      expect(await repair(env, { apply: false, authority: undefined })).toEqual(noRepairs);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
      bind(env);
      seed(env, source, { lifecycleRevision: binding });
      if (conflicting) {
        seed(env, alias, {
          meta: { ...meta, runtimeSessionName: "conflicting-alias", lastActivityAt: 200 },
          now: () => 200,
        });
      }
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const before = rows(db);
      const report = {
        ...noRepairs,
        found: 1,
        warnings: conflicting ? [expect.stringContaining("conflicting payloads retained")] : [],
      };
      expect(await repair(env, { apply: false, authority: undefined })).toEqual(report);
      expect(rows(db)).toEqual(before);
      await expect(repair(env, { authority: undefined })).rejects.toThrow("maintenance authority");
      const changes: unknown[] = [];
      const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
      try {
        await withDoctorSqliteMaintenanceLock({
          env,
          operation: "ACP test repair",
          run: async (authority) => {
            expect(await repair(env, { authority })).toEqual({
              ...report,
              repaired: 1,
              backups: [expect.any(String)],
            });
            if (!conflicting) {
              expect(await repair(env, { authority })).toEqual(noRepairs);
            }
          },
        });
      } finally {
        unsubscribe();
      }
      expect(rows(db)).toEqual([
        {
          ...before.find((row) => row.session_key === source),
          session_key: buildAcpDatabaseSessionKey(key, "harness"),
        },
        ...before.filter((row) => row.session_key !== source),
      ]);
      expect(changes).toEqual([{ agentId: "harness", sessionKey: key }]);
    }),
);

it.each(["stale-session-id", "conflicting-canonical"])(
  "retains the complete source after %s",
  (condition) =>
    withState(async ({ env }) => {
      bind(env);
      seed(env, alias, {
        lifecycleRevision:
          condition === "stale-session-id" ? entry.sessionId : entry.lifecycleRevision,
        now: () => (condition === "stale-session-id" ? 25 : 100),
      });
      if (condition === "conflicting-canonical") {
        seed(env, buildAcpDatabaseSessionKey(key, "harness"), {
          meta: { ...meta, runtimeSessionName: "canonical-runtime" },
          now: undefined,
        });
      }
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const before = rows(db);
      const result = await repair(env);
      expect(result.repaired).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(rows(db)).toEqual(before);
    }),
);

it.each(["revoked-authority", "changed-source", "changed-binding"])(
  "revalidates %s before committing",
  (condition) =>
    withState(async ({ env }) => {
      bind(env);
      seed(env, alias, { now: undefined });
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const before = rows(db);
      let active = true;
      let injected = false;
      const originalWrite = stateDatabase.runOpenClawStateWriteTransaction;
      using mocks = new DisposableStack();
      mocks.use(
        vi
          .spyOn(stateDatabase, "runOpenClawStateWriteTransaction")
          .mockImplementation((operation, options) => {
            if (!injected) {
              injected = true;
              if (condition === "changed-source") {
                db.prepare(
                  "UPDATE acp_sessions SET runtime_session_name = ? WHERE session_key = ?",
                ).run("changed-runtime", alias);
              } else if (condition === "changed-binding") {
                replaceSessionEntrySync(
                  { agentId: "harness", sessionKey: key, env },
                  { ...entry, lifecycleRevision: "replacement-revision" },
                );
              } else {
                active = false;
              }
            }
            return originalWrite(operation, options);
          }),
      );
      const pendingRepair = repair(env, {
        authority: {
          assertCurrent() {
            if (!active) {
              throw new Error("maintenance authority revoked");
            }
          },
        },
      });
      if (condition === "revoked-authority") {
        await expect(pendingRepair).rejects.toThrow("maintenance authority revoked");
      } else {
        expect(await pendingRepair).toMatchObject(retained("changed"));
      }
      expect(rows(db)).toEqual(
        condition === "changed-source"
          ? [{ ...before[0], runtime_session_name: "changed-runtime" }]
          : before,
      );
    }),
);

it.each([
  ["global", "global"],
  ["project", buildAcpDatabaseSessionKey("project")],
])("canonicalizes %s from %s with a backup", (sessionKey, sourceKey) =>
  withState(async ({ env }) => {
    bind(env, sessionKey, "main");
    seed(env, sourceKey);
    const { db } = stateDatabase.openOpenClawStateDatabase({ env });
    const before = rows(db);
    const storeSessionKey = resolveSqliteSessionKey(sessionKey, "main");
    const result = await repair(env, {
      integrityCheck: sessionKey === "global" ? undefined : "full",
    });
    expect(result).toMatchObject(repaired);
    expectBackup(result.backups![0]!, (backup) => expect(rows(backup)).toEqual(before));
    expect(fs.statSync(result.backups![0]!).mode & 0o777).toBe(0o600);
    expect(rows(db)).toEqual([
      {
        ...before[0],
        session_key: buildAcpDatabaseSessionKey(storeSessionKey, "main"),
      },
    ]);
    expect(readAcpSessionEntry({ cfg, env, agentId: "main", sessionKey })?.acp).toEqual(meta);
    expect(await repair(env)).toEqual(noRepairs);
  }),
);

it("preserves embedded metadata and prevents replay after closure", () =>
  withState(async ({ env }) => {
    const sessionKey = "agent:main:embedded-acp";
    const scope = { agentId: "main", sessionKey, env };
    const original = {
      ...entry,
      acp: { ...meta, historicalNote: "preserved in the source backup" },
    };
    replaceSessionEntrySync(scope, original);
    seed(env, buildAcpDatabaseSessionKey(normalizeStoreSessionKey(sessionKey), "main"));
    const source = sourceRow(openOpenClawAgentDatabase(scope).db, sessionKey);
    const result = await repair(env);
    expect(result).toMatchObject(repaired);
    expectBackup(result.backups![0]!, (backup) =>
      expect(sourceRow(backup, sessionKey)).toEqual(source),
    );
    expect(loadExactSessionEntry(scope)?.entry).not.toHaveProperty("acp");
    expect(readAcpSessionMetaForEntry({ ...scope, entry })).toEqual(meta);
    const shared = stateDatabase.openOpenClawStateDatabase({ env });
    const receipts = rows(shared.db, "migration_sources");
    expect(receipts).toHaveLength(1);
    shared.db
      .prepare("DELETE FROM acp_sessions WHERE session_key = ?")
      .run(buildAcpDatabaseSessionKey(normalizeStoreSessionKey(sessionKey), "main"));
    // An interrupted source cleanup can leave the exact original embedded field behind.
    replaceSessionEntrySync(scope, original);
    expect(await repair(env)).toMatchObject({ found: 1, repaired: 1, warnings: [] });
    expect(readAcpSessionMetaForEntry({ ...scope, entry })).toBeUndefined();
    expect(loadExactSessionEntry(scope)?.entry).not.toHaveProperty("acp");
    expect(rows(shared.db, "migration_sources")).toEqual(receipts);
  }));

it("retains embedded conflicts and post-import source changes", () =>
  withState(async ({ env }) => {
    const sessionKey = "agent:main:embedded-source-conflict";
    const canonicalKey = buildAcpDatabaseSessionKey(sessionKey, "main");
    const scope = { agentId: "main", sessionKey, env };
    const original = { ...entry, acp: meta };
    replaceSessionEntrySync(scope, original);
    seed(env, canonicalKey, { now: () => 99 });
    const { db } = stateDatabase.openOpenClawStateDatabase({ env });
    const before = rows(db);
    expect(await repair(env)).toMatchObject(retained("conflicts with embedded metadata"));
    expect(loadExactSessionEntry(scope)?.entry.acp).toEqual(meta);
    expect(rows(db)).toEqual(before);
    expect(rows(db, "migration_sources")).toEqual([]);

    db.prepare("DELETE FROM acp_sessions WHERE session_key = ?").run(canonicalKey);
    expect(await repair(env)).toMatchObject({ repaired: 1, warnings: [] });
    const receipts = rows(db, "migration_sources");
    db.prepare("DELETE FROM acp_sessions WHERE session_key = ?").run(canonicalKey);
    for (const changed of [
      { ...original, updatedAt: 200 },
      { ...original, sessionStartedAt: 75 },
      { ...original, sessionId: "reused-revision-with-new-session" },
    ]) {
      replaceSessionEntrySync(scope, changed);
      expect(await repair(env)).toMatchObject(
        retained("Retained ACP metadata changed after import"),
      );
      expect(loadExactSessionEntry(scope)?.entry).toMatchObject(changed);
      expect(rows(db)).toEqual([]);
      expect(rows(db, "migration_sources")).toEqual(receipts);
    }
  }));

it.each(["keys", "embedded"])(
  "rejects %s backup mismatches despite restored source bytes",
  (shape) =>
    withState(async ({ env }) => {
      const sessionKey = "agent:main:acp:backup-source";
      const scope = { agentId: "main", sessionKey, env };
      replaceSessionEntrySync(scope, shape === "embedded" ? { ...entry, acp: meta } : entry);
      const shared = stateDatabase.openOpenClawStateDatabase({ env });
      if (shape === "keys") {
        seed(env, sessionKey);
      }
      const agent = openOpenClawAgentDatabase(scope);
      const originalRows = rows(shared.db);
      const originalJson = sourceRow(agent.db, sessionKey)?.entry_json;
      if (typeof originalJson !== "string") {
        throw new Error("Expected a persisted synthetic ACP source entry");
      }
      const rewrite = (changed: boolean) => {
        if (shape === "keys") {
          shared.db
            .prepare("UPDATE acp_sessions SET runtime_session_name = ? WHERE session_key = ?")
            .run(changed ? "changed-during-backup" : meta.runtimeSessionName, sessionKey);
        } else {
          const value = changed
            ? JSON.stringify({
                ...entry,
                acp: { ...meta, runtimeSessionName: "changed-during-backup" },
              })
            : originalJson;
          agent.db
            .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run(value, sessionKey);
        }
      };
      const createSnapshot = snapshots.createVerifiedSqliteSnapshot;
      using mocks = new DisposableStack();
      mocks.use(
        vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockImplementation(async (options) => {
          rewrite(true);
          try {
            return await createSnapshot({
              ...options,
              beforePublish: async () => {
                rewrite(false);
                await options.beforePublish?.();
              },
            });
          } finally {
            rewrite(false);
          }
        }),
      );
      const result = await repair(env);
      expect(result).toMatchObject(retained("backup does not match the planned"));
      expect(result.backups ?? []).toEqual([]);
      expect(rows(shared.db)).toEqual(originalRows);
      expect(sourceRow(agent.db, sessionKey)).toEqual({ entry_json: originalJson });
      expect(rows(shared.db, "migration_sources")).toEqual([]);
    }),
);

it("binds embedded shared-store metadata to its logical owner", () =>
  withState(async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const config = {
      agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } },
      session: { store: storePath },
    };
    openOpenClawAgentDatabase({ agentId: "main", path: storePath, env: state.env });
    const sessionKey = "agent:ops:acp:shared-owner";
    const scope = { agentId: "ops", storePath, sessionKey, env: state.env };
    replaceSessionEntrySync(scope, { ...entry, acp: meta });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "peer" }, promptedAt: 50 });
    expect(await repair(state.env, { cfg: config })).toMatchObject({
      found: 1,
      repaired: 1,
      warnings: [],
    });
    expect(readAcpSessionMetaForEntry({ ...scope, entry })).toEqual(meta);
    expect(loadExactSessionEntry(scope)?.entry).not.toHaveProperty("acp");
    expect(loadExactSessionEntry(scope)?.entry.participants).toEqual([
      expect.objectContaining({ identity: { type: "agent", id: "peer" } }),
    ]);
    const { db } = stateDatabase.openOpenClawStateDatabase({ env: state.env });
    expect(db.prepare("SELECT session_key FROM acp_sessions").all()).toEqual([
      { session_key: buildAcpDatabaseSessionKey(sessionKey, "ops") },
    ]);
  }));

it.each(["ambiguous", "unreadable"])("retains an alias with %s ownership", (condition) =>
  withState(async ({ env }) => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: {}, ops: {} },
        ...(condition === "ambiguous" ? { defaults: { systemAgent: { agentId: "main" } } } : {}),
      },
    };
    const sourceKey = "@agent:ops:global";
    bind(env, "global", "ops");
    if (condition === "ambiguous") {
      bind(env, sourceKey, "main");
    } else {
      const unreadable = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      fs.mkdirSync(path.dirname(unreadable), { recursive: true });
      fs.writeFileSync(unreadable, "not a SQLite database");
    }
    seed(env, sourceKey);
    const { db } = stateDatabase.openOpenClawStateDatabase({ env });
    const before = rows(db);
    const warning = expect.stringContaining(
      condition === "ambiguous" ? "multiple session owners" : "could not inspect every candidate",
    );
    expect(await repair(env, { cfg: config })).toMatchObject({
      repaired: 0,
      warnings: condition === "ambiguous" ? [warning] : expect.arrayContaining([warning]),
    });
    expect(rows(db)).toEqual(before);
  }),
);
