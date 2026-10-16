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
import * as snapshots from "../../infra/sqlite-snapshot.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { repairAcpSessionMetaKeysForDoctor } from "./session-meta-doctor.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
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
const meta = {
  backend: "fixture",
  agent: "harness",
  runtimeSessionName: "original-runtime",
  mode: "persistent" as const,
  state: "idle" as const,
  lastActivityAt: 100,
};

it.each([
  { source: key, binding: entry.lifecycleRevision, conflicting: true },
  { source: alias, binding: undefined, conflicting: false },
])(
  "Doctor preserves $source with binding=$binding and conflicting=$conflicting aliases",
  async ({ source, binding, conflicting }) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env, stateDir }) => {
      expect(await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: false })).toEqual({
        found: 0,
        repaired: 0,
        scannedRows: 0,
        warnings: [],
      });
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
      replaceSessionEntrySync({ agentId: "harness", sessionKey: key, env }, entry);
      writeAcpSessionMetaForMigration({
        env,
        sessionKey: source,
        lifecycleRevision: binding,
        meta,
        now: () => 100,
      });
      if (conflicting) {
        writeAcpSessionMetaForMigration({
          env,
          sessionKey: alias,
          lifecycleRevision: entry.lifecycleRevision,
          meta: { ...meta, runtimeSessionName: "conflicting-alias", lastActivityAt: 200 },
          now: () => 200,
        });
      }
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const readRows = () => db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all();
      const before = readRows();
      const report = {
        found: 1,
        repaired: 0,
        scannedRows: conflicting ? 2 : 1,
        warnings: conflicting ? [expect.stringContaining("conflicting payloads retained")] : [],
      };
      expect(await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: false })).toEqual(report);
      expect(readRows()).toEqual(before);
      await expect(repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: true })).rejects.toThrow(
        "maintenance authority",
      );
      const changes: unknown[] = [];
      const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
      try {
        await withDoctorSqliteMaintenanceLock({
          env,
          operation: "ACP test repair",
          run: async (authority) => {
            expect(
              await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: true, authority }),
            ).toEqual({ ...report, repaired: 1, backups: [expect.any(String)] });
            if (!conflicting) {
              expect(
                await repairAcpSessionMetaKeysForDoctor({ cfg, env, apply: true, authority }),
              ).toEqual({
                found: 0,
                repaired: 0,
                scannedRows: 1,
                warnings: [],
              });
            }
          },
        });
      } finally {
        unsubscribe();
      }
      expect(readRows()).toEqual([
        {
          ...before.find((row) => row.session_key === source),
          session_key: buildAcpDatabaseSessionKey(key, "harness"),
        },
        ...before.filter((row) => row.session_key !== source),
      ]);
      expect(changes).toEqual([{ agentId: "harness", sessionKey: key }]);
    });
  },
);

it.each(["stale-session-id", "conflicting-canonical"])(
  "Doctor retains the complete ACP source when repair sees %s",
  async (condition) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
      replaceSessionEntrySync({ agentId: "harness", sessionKey: key, env }, entry);
      writeAcpSessionMetaForMigration({
        env,
        sessionKey: alias,
        meta,
        lifecycleRevision:
          condition === "stale-session-id" ? entry.sessionId : entry.lifecycleRevision,
        now: () => (condition === "stale-session-id" ? 25 : 100),
      });
      if (condition === "conflicting-canonical") {
        writeAcpSessionMetaForMigration({
          env,
          sessionKey: buildAcpDatabaseSessionKey(key, "harness"),
          lifecycleRevision: entry.lifecycleRevision,
          meta: { ...meta, runtimeSessionName: "canonical-runtime" },
        });
      }
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const before = db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all();
      const result = await repairAcpSessionMetaKeysForDoctor({
        cfg,
        env,
        apply: true,
        authority: { assertCurrent() {} },
      });
      expect(result.repaired).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all()).toEqual(before);
    });
  },
);

it.each(["revoked-authority", "changed-source", "changed-binding"])(
  "Doctor rereads exact ownership before committing after %s",
  async (condition) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
      replaceSessionEntrySync({ agentId: "harness", sessionKey: key, env }, entry);
      writeAcpSessionMetaForMigration({
        env,
        sessionKey: alias,
        lifecycleRevision: entry.lifecycleRevision,
        meta,
      });
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const before = db.prepare("SELECT * FROM acp_sessions").all();
      let active = true;
      let injected = false;
      const originalWrite = stateDatabase.runOpenClawStateWriteTransaction;
      const write = vi
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
        });
      try {
        const repair = repairAcpSessionMetaKeysForDoctor({
          cfg,
          env,
          apply: true,
          authority: {
            assertCurrent() {
              if (!active) {
                throw new Error("maintenance authority revoked");
              }
            },
          },
        });
        if (condition === "revoked-authority") {
          await expect(repair).rejects.toThrow("maintenance authority revoked");
        } else {
          const result = await repair;
          expect(result.repaired).toBe(0);
          expect(result.warnings).toEqual([expect.stringContaining("changed")]);
        }
      } finally {
        write.mockRestore();
      }
      expect(db.prepare("SELECT * FROM acp_sessions").all()).toEqual(
        condition === "changed-source"
          ? [{ ...before[0], runtime_session_name: "changed-runtime" }]
          : before,
      );
    });
  },
);

it.each([
  { label: "bare key", sessionKey: "global", sourceKey: "global" },
  {
    label: "ownerless encoded key",
    sessionKey: "project",
    sourceKey: buildAcpDatabaseSessionKey("project"),
  },
])(
  "Doctor backs up and canonicalizes $label before runtime access",
  async ({ sessionKey, sourceKey }) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
      replaceSessionEntrySync({ agentId: "main", sessionKey, env }, entry);
      writeAcpSessionMetaForMigration({
        env,
        sessionKey: sourceKey,
        lifecycleRevision: entry.lifecycleRevision,
        meta,
        now: () => 100,
      });
      const { db } = stateDatabase.openOpenClawStateDatabase({ env });
      const before = db.prepare("SELECT * FROM acp_sessions").all();
      const storeSessionKey = resolveSqliteSessionKey(sessionKey, "main");
      const input = { cfg, env, agentId: "main", sessionKey: storeSessionKey, entry };
      expect(readAcpSessionMetaForEntry(input)).toBeUndefined();
      const result = await repairAcpSessionMetaKeysForDoctor({
        cfg,
        env,
        apply: true,
        authority: { assertCurrent() {} },
      });
      expect(result).toMatchObject({
        found: 1,
        repaired: 1,
        warnings: [],
        backups: [expect.any(String)],
      });
      const backup = new DatabaseSync(result.backups![0]!, { readOnly: true });
      try {
        expect(backup.prepare("SELECT * FROM acp_sessions").all()).toEqual(before);
      } finally {
        backup.close();
      }
      expect(fs.statSync(result.backups![0]!).mode & 0o777).toBe(0o600);
      expect(db.prepare("SELECT * FROM acp_sessions").all()).toEqual([
        {
          ...before[0],
          session_key: buildAcpDatabaseSessionKey(storeSessionKey, "main"),
        },
      ]);
      expect(readAcpSessionMetaForEntry(input)).toEqual(meta);
      expect(readAcpSessionEntry({ cfg, env, agentId: "main", sessionKey })?.acp).toEqual(meta);
      expect(
        await repairAcpSessionMetaKeysForDoctor({
          cfg,
          env,
          apply: true,
          authority: { assertCurrent() {} },
        }),
      ).toEqual({ found: 0, repaired: 0, scannedRows: 1, warnings: [] });
    });
  },
);

it("Doctor preserves embedded SQLite ACP metadata and prevents replay after closure", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
    const sessionKey = "agent:main:embedded-acp";
    const scope = { agentId: "main", sessionKey, env };
    const original = {
      ...entry,
      acp: { ...meta, historicalNote: "preserved in the source backup" },
    };
    replaceSessionEntrySync(scope, original);
    writeAcpSessionMetaForMigration({
      env,
      sessionKey: buildAcpDatabaseSessionKey(normalizeStoreSessionKey(sessionKey), "main"),
      lifecycleRevision: entry.lifecycleRevision,
      meta,
      now: () => 100,
    });
    const agent = openOpenClawAgentDatabase(scope);
    const source = agent.db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey);
    const result = await repairAcpSessionMetaKeysForDoctor({
      cfg,
      env,
      apply: true,
      authority: { assertCurrent() {} },
    });
    expect(result).toMatchObject({
      found: 1,
      repaired: 1,
      warnings: [],
      backups: [expect.any(String)],
    });
    const backup = new DatabaseSync(result.backups![0]!, { readOnly: true });
    try {
      expect(
        backup
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(sessionKey),
      ).toEqual(source);
    } finally {
      backup.close();
    }
    expect(loadExactSessionEntry(scope)?.entry).not.toHaveProperty("acp");
    expect(readAcpSessionMetaForEntry({ ...scope, entry })).toEqual(meta);
    const shared = stateDatabase.openOpenClawStateDatabase({ env });
    const receipts = shared.db.prepare("SELECT * FROM migration_sources ORDER BY source_key").all();
    expect(receipts).toHaveLength(1);
    shared.db
      .prepare("DELETE FROM acp_sessions WHERE session_key = ?")
      .run(buildAcpDatabaseSessionKey(normalizeStoreSessionKey(sessionKey), "main"));
    // An interrupted source cleanup can leave the exact original embedded field behind.
    replaceSessionEntrySync(scope, original);
    const rerun = await repairAcpSessionMetaKeysForDoctor({
      cfg,
      env,
      apply: true,
      authority: { assertCurrent() {} },
    });
    expect(rerun).toMatchObject({ found: 1, repaired: 1, warnings: [] });
    expect(readAcpSessionMetaForEntry({ ...scope, entry })).toBeUndefined();
    expect(loadExactSessionEntry(scope)?.entry).not.toHaveProperty("acp");
    expect(shared.db.prepare("SELECT * FROM migration_sources ORDER BY source_key").all()).toEqual(
      receipts,
    );
  });
});

it("Doctor retains embedded timestamp conflicts and changed sources after an interrupted import", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
    const sessionKey = "agent:main:embedded-source-conflict";
    const canonicalKey = buildAcpDatabaseSessionKey(sessionKey, "main");
    const scope = { agentId: "main", sessionKey, env };
    const original = { ...entry, acp: meta };
    replaceSessionEntrySync(scope, original);
    writeAcpSessionMetaForMigration({
      env,
      sessionKey: canonicalKey,
      lifecycleRevision: entry.lifecycleRevision,
      meta,
      now: () => 99,
    });
    const repair = () =>
      repairAcpSessionMetaKeysForDoctor({
        cfg,
        env,
        apply: true,
        authority: { assertCurrent() {} },
      });
    const { db } = stateDatabase.openOpenClawStateDatabase({ env });
    const before = db.prepare("SELECT * FROM acp_sessions").all();
    expect(await repair()).toMatchObject({
      repaired: 0,
      warnings: [expect.stringContaining("conflicts with embedded metadata")],
    });
    expect(loadExactSessionEntry(scope)?.entry.acp).toEqual(meta);
    expect(db.prepare("SELECT * FROM acp_sessions").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM migration_sources").all()).toEqual([]);

    db.prepare("DELETE FROM acp_sessions WHERE session_key = ?").run(canonicalKey);
    expect(await repair()).toMatchObject({ repaired: 1, warnings: [] });
    const receipts = db.prepare("SELECT * FROM migration_sources").all();
    db.prepare("DELETE FROM acp_sessions WHERE session_key = ?").run(canonicalKey);
    for (const changed of [
      { ...original, updatedAt: 200 },
      { ...original, sessionStartedAt: 75 },
      { ...original, sessionId: "reused-revision-with-new-session" },
    ]) {
      replaceSessionEntrySync(scope, changed);
      expect(await repair()).toMatchObject({
        repaired: 0,
        warnings: [expect.stringContaining("Retained ACP metadata changed after import")],
      });
      expect(loadExactSessionEntry(scope)?.entry).toMatchObject(changed);
      expect(db.prepare("SELECT * FROM acp_sessions").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM migration_sources").all()).toEqual(receipts);
    }
  });
});

it("Doctor preserves a legacy key with two live interpretations", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
    };
    const sourceKey = "@agent:ops:global";
    replaceSessionEntrySync({ agentId: "ops", sessionKey: "global", env }, entry);
    replaceSessionEntrySync({ agentId: "main", sessionKey: sourceKey, env }, entry);
    writeAcpSessionMetaForMigration({
      env,
      sessionKey: sourceKey,
      lifecycleRevision: entry.lifecycleRevision,
      meta,
      now: () => 100,
    });
    const { db } = stateDatabase.openOpenClawStateDatabase({ env });
    const before = db.prepare("SELECT * FROM acp_sessions").all();
    expect(
      await repairAcpSessionMetaKeysForDoctor({
        cfg: config,
        env,
        apply: true,
        authority: { assertCurrent() {} },
      }),
    ).toMatchObject({
      repaired: 0,
      warnings: [expect.stringContaining("multiple session owners")],
    });
    expect(db.prepare("SELECT * FROM acp_sessions").all()).toEqual(before);
  });
});

it.each(["keys", "embedded"])(
  "Doctor refuses a mismatched %s backup even if source bytes return before commit",
  async (shape) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
      const sessionKey = "agent:main:acp:backup-source";
      const scope = { agentId: "main", sessionKey, env };
      replaceSessionEntrySync(scope, shape === "embedded" ? { ...entry, acp: meta } : entry);
      const shared = stateDatabase.openOpenClawStateDatabase({ env });
      if (shape === "keys") {
        writeAcpSessionMetaForMigration({
          env,
          sessionKey,
          lifecycleRevision: entry.lifecycleRevision,
          meta,
          now: () => 100,
        });
      }
      const agent = openOpenClawAgentDatabase(scope);
      const originalRows = shared.db.prepare("SELECT * FROM acp_sessions").all();
      const sourceRow = agent.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(sessionKey);
      const originalJson = sourceRow?.entry_json;
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
      const snapshot = vi
        .spyOn(snapshots, "createVerifiedSqliteSnapshot")
        .mockImplementation(async (options) => {
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
        });
      try {
        const result = await repairAcpSessionMetaKeysForDoctor({
          cfg,
          env,
          apply: true,
          authority: { assertCurrent() {} },
        });
        expect(result.repaired).toBe(0);
        expect(result.warnings).toEqual([
          expect.stringContaining("backup does not match the planned"),
        ]);
        expect(result.backups ?? []).toEqual([]);
        expect(shared.db.prepare("SELECT * FROM acp_sessions").all()).toEqual(originalRows);
        expect(
          agent.db
            .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
            .get(sessionKey),
        ).toEqual({ entry_json: originalJson });
        expect(shared.db.prepare("SELECT * FROM migration_sources").all()).toEqual([]);
      } finally {
        snapshot.mockRestore();
      }
    });
  },
);

it("Doctor binds embedded shared-store metadata to its logical session owner", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async (state) => {
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
    expect(
      await repairAcpSessionMetaKeysForDoctor({
        cfg: config,
        env: state.env,
        apply: true,
        authority: { assertCurrent() {} },
      }),
    ).toMatchObject({ found: 1, repaired: 1, warnings: [] });
    expect(readAcpSessionMetaForEntry({ ...scope, entry })).toEqual(meta);
    expect(loadExactSessionEntry(scope)?.entry).not.toHaveProperty("acp");
    expect(loadExactSessionEntry(scope)?.entry.participants).toEqual([
      expect.objectContaining({ identity: { type: "agent", id: "peer" } }),
    ]);
    const { db } = stateDatabase.openOpenClawStateDatabase({ env: state.env });
    expect(db.prepare("SELECT session_key FROM acp_sessions").all()).toEqual([
      { session_key: buildAcpDatabaseSessionKey(sessionKey, "ops") },
    ]);
  });
});

it("Doctor retains an alias when a competing candidate store cannot be inspected", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env }) => {
    const config = { agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } } };
    const sourceKey = "@agent:ops:global";
    replaceSessionEntrySync({ agentId: "ops", sessionKey: "global", env }, entry);
    const unreadable = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    fs.mkdirSync(path.dirname(unreadable), { recursive: true });
    fs.writeFileSync(unreadable, "not a SQLite database");
    writeAcpSessionMetaForMigration({
      env,
      sessionKey: sourceKey,
      lifecycleRevision: entry.lifecycleRevision,
      meta,
      now: () => 100,
    });
    const { db } = stateDatabase.openOpenClawStateDatabase({ env });
    const before = db.prepare("SELECT * FROM acp_sessions").all();
    const result = await repairAcpSessionMetaKeysForDoctor({
      cfg: config,
      env,
      apply: true,
      authority: { assertCurrent() {} },
    });
    expect(result.repaired).toBe(0);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("could not inspect every candidate"),
    );
    expect(db.prepare("SELECT * FROM acp_sessions").all()).toEqual(before);
  });
});
