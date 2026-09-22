import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repairCanonicalSessionKeys } from "../../commands/doctor-session-canonical-keys.js";
import { runDoctorSessionSqlite } from "../../commands/doctor-session-sqlite.js";
import {
  deleteSessionEntryLifecycle,
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../../infra/deferred-plugin-migrations.js";
import { migrateLegacyAcpSessionMetadata } from "../../infra/state-migrations.session-store.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  listAcpSessionEntries,
  readAcpSessionMeta,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "./session-meta.js";

const SESSION_KEY = "agent:main:retained-acp";
const SESSION_ID = "retained-acp-session";
const PLUGIN_ID = "fixture-plugin";
const LEGACY_META: SessionAcpMeta = {
  backend: "fixture-backend",
  agent: "main",
  runtimeSessionName: "legacy-runtime",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 20,
};

async function seedRetainedSource(
  state: OpenClawTestState,
  lifecycleRevision?: string,
  sourceSessionKey = SESSION_KEY,
) {
  const storePath = path.join(state.sessionsDir("main"), "sessions.json");
  const transcriptPath = path.join(path.dirname(storePath), `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    transcriptPath,
    [
      { type: "session", version: 3, id: SESSION_ID },
      {
        type: "message",
        id: "retained-message",
        parentId: null,
        message: { role: "user", content: "Synthetic retained ACP session" },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [sourceSessionKey]: {
        sessionId: SESSION_ID,
        ...(lifecycleRevision ? { lifecycleRevision } : {}),
        sessionFile: path.basename(transcriptPath),
        updatedAt: 20,
        acp: LEGACY_META,
      },
    }),
  );
  const cfg: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
  await state.writeConfig(cfg);
  recordDeferredPluginMigrations({
    env: state.env,
    pending: [
      {
        pluginId: PLUGIN_ID,
        reason: "The configured plugin is not installed.",
        command: "openclaw plugins install @example/fixture-plugin",
      },
    ],
  });
  const originals = new Map([
    [storePath, fs.readFileSync(storePath)],
    [transcriptPath, fs.readFileSync(transcriptPath)],
  ]);
  const scope = { agentId: "main", storePath, env: state.env, sessionKey: SESSION_KEY };
  const acpScope = { cfg, env: state.env, agentId: "main", sessionKey: SESSION_KEY };
  const migrateAcp = () =>
    migrateLegacyAcpSessionMetadata({
      cfg,
      env: state.env,
      pluginSessionStoreAgentIds: [],
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
  const importCore = () =>
    runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
  const assertOriginalsRetained = () => {
    for (const [file, original] of originals) {
      expect(fs.readFileSync(file)).toEqual(original);
    }
  };
  return { scope, acpScope, migrateAcp, importCore, assertOriginalsRetained };
}

function reopenDatabases() {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

describe("retained legacy ACP metadata", () => {
  it("preserves canonical closure before first ACP import", async () => {
    await withOpenClawTestState({ label: "retained-acp-closed-first" }, async (state) => {
      const fixture = await seedRetainedSource(state);
      expect((await fixture.importCore()).totals.importedEntries).toBe(1);
      await upsertAcpSessionMeta({
        ...fixture.acpScope,
        mutate: () => ({ ...LEGACY_META, runtimeSessionName: "canonical-runtime" }),
      });
      await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => null });
      expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
      reopenDatabases();
      expect((await fixture.importCore()).totals.importedEntries).toBe(0);
      expect((await fixture.migrateAcp()).warnings).toEqual([]);
      expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
      fixture.assertOriginalsRetained();
    });
  });

  it("preserves canonical closure after a session-key repair and repair rerun", async () => {
    await withOpenClawTestState({ label: "retained-acp-key-repair" }, async (state) => {
      const fixture = await seedRetainedSource(state, undefined, SESSION_KEY.toUpperCase());
      expect((await fixture.importCore()).totals.importedEntries).toBe(1);
      expect(
        (
          await repairCanonicalSessionKeys({
            apply: true,
            cfg: fixture.acpScope.cfg,
            env: state.env,
          })
        ).repairedGroups,
      ).toBe(1);
      expect(
        (
          await repairCanonicalSessionKeys({
            apply: true,
            cfg: fixture.acpScope.cfg,
            env: state.env,
          })
        ).repairedGroups,
      ).toBe(0);
      await upsertAcpSessionMeta({
        ...fixture.acpScope,
        mutate: () => ({ ...LEGACY_META, runtimeSessionName: "canonical-runtime" }),
      });
      await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => null });
      reopenDatabases();
      expect((await fixture.migrateAcp()).warnings).toEqual([]);
      expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
      fixture.assertOriginalsRetained();
    });
  });

  it.each(["initialize", "close"] as const)(
    "keeps canonical ACP %s atomic with source consumption",
    async (operation) => {
      await withOpenClawTestState({ label: `retained-acp-atomic-${operation}` }, async (state) => {
        const fixture = await seedRetainedSource(state);
        expect((await fixture.importCore()).totals.importedEntries).toBe(1);
        const canonicalMeta = { ...LEGACY_META, runtimeSessionName: "canonical-runtime" };
        if (operation === "close") {
          writeAcpSessionMetaForMigration({
            ...fixture.acpScope,
            sessionId: SESSION_ID,
            meta: canonicalMeta,
          });
        }
        const before = readAcpSessionMeta(fixture.acpScope);
        const { db } = openOpenClawStateDatabase({ env: state.env });
        const sources = db.prepare("SELECT * FROM migration_sources ORDER BY source_key").all();
        const runs = db.prepare("SELECT * FROM migration_runs ORDER BY id").all();
        db.exec(
          "CREATE TRIGGER reject_canonical_acp_receipt BEFORE INSERT ON migration_sources BEGIN SELECT RAISE(ABORT, 'injected canonical ACP receipt failure'); END",
        );
        const mutate = () => (operation === "close" ? null : canonicalMeta);
        try {
          await expect(upsertAcpSessionMeta({ ...fixture.acpScope, mutate })).rejects.toThrow(
            "injected canonical ACP receipt failure",
          );
          expect(readAcpSessionMeta(fixture.acpScope)).toEqual(before);
          expect(db.prepare("SELECT * FROM migration_sources ORDER BY source_key").all()).toEqual(
            sources,
          );
          expect(db.prepare("SELECT * FROM migration_runs ORDER BY id").all()).toEqual(runs);
        } finally {
          db.exec("DROP TRIGGER reject_canonical_acp_receipt");
        }
        await upsertAcpSessionMeta({ ...fixture.acpScope, mutate });
        await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => null });
        reopenDatabases();
        expect((await fixture.migrateAcp()).warnings).toEqual([]);
        expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
        fixture.assertOriginalsRetained();
      });
    },
  );

  it("imports ACP for the first time after the canonical session import completed", async () => {
    await withOpenClawTestState({ label: "retained-acp-first-import" }, async (state) => {
      const fixture = await seedRetainedSource(state);
      const imported = await fixture.importCore();
      expect(imported.totals.importedEntries).toBe(1);
      expect(imported.targets.flatMap((target) => target.issues)).toEqual([
        expect.objectContaining({ code: "plugin_migration_source_retained" }),
      ]);
      expect(loadExactSessionEntry(fixture.scope)?.entry.sessionId).toBe(SESSION_ID);
      expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
      reopenDatabases();

      expect((await fixture.migrateAcp()).warnings).toEqual([]);
      expect(readAcpSessionMeta(fixture.acpScope)).toEqual(LEGACY_META);
      fixture.assertOriginalsRetained();
    });
  });

  it.each(["pending", "resolved"] as const)(
    "does not revive closed ACP metadata after reopening with the plugin %s",
    async (pluginState) => {
      await withOpenClawTestState({ label: `retained-acp-close-${pluginState}` }, async (state) => {
        const fixture = await seedRetainedSource(state);
        expect((await fixture.migrateAcp()).warnings).toEqual([]);
        expect((await fixture.importCore()).totals.importedEntries).toBe(1);
        expect(readAcpSessionMeta(fixture.acpScope)).toEqual(LEGACY_META);

        await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => null });
        expect(loadExactSessionEntry(fixture.scope)?.entry.sessionId).toBe(SESSION_ID);
        expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
        fixture.assertOriginalsRetained();
        if (pluginState === "resolved") {
          recordDeferredPluginMigrations({
            env: state.env,
            pending: [],
            resolvedPluginIds: [PLUGIN_ID],
          });
        }
        reopenDatabases();

        expect((await fixture.migrateAcp()).warnings).toEqual([]);
        expect(loadExactSessionEntry(fixture.scope)?.entry.sessionId).toBe(SESSION_ID);
        expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
        expect(await listAcpSessionEntries(fixture.acpScope)).toEqual([]);
        fixture.assertOriginalsRetained();
        if (pluginState === "resolved") {
          const settled = await fixture.importCore();
          expect(settled.totals.importedEntries).toBe(0);
          expect(settled.targets.flatMap((target) => target.issues)).toEqual([]);
          expect(fs.existsSync(fixture.scope.storePath)).toBe(false);
          expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
        }
      });
    },
  );

  it("keeps import completion bound to the ACP lifecycle when the legacy session id changes", async () => {
    await withOpenClawTestState({ label: "retained-acp-lifecycle" }, async (state) => {
      const revision = "00000000-0000-4000-8000-000000000007";
      const fixture = await seedRetainedSource(state, revision);
      expect((await fixture.migrateAcp()).warnings).toEqual([]);
      expect((await fixture.importCore()).totals.importedEntries).toBe(1);
      expect(loadExactSessionEntry(fixture.scope)?.entry.lifecycleRevision).toBe(revision);
      await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => null });
      const changed = fs
        .readFileSync(fixture.scope.storePath, "utf8")
        .replace(SESSION_ID, "rekeyed-source-session");
      fs.writeFileSync(fixture.scope.storePath, changed);
      reopenDatabases();

      expect((await fixture.migrateAcp()).warnings).toEqual([]);
      expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
      expect(fs.readFileSync(fixture.scope.storePath, "utf8")).toBe(changed);
    });
  });

  it.each([false, true])(
    "preserves canonical ACP edits (prior import: %s)",
    async (priorImport) => {
      await withOpenClawTestState({ label: "retained-acp-edit" }, async (state) => {
        const fixture = await seedRetainedSource(state);
        if (priorImport) {
          expect((await fixture.migrateAcp()).warnings).toEqual([]);
        }
        expect((await fixture.importCore()).totals.importedEntries).toBe(1);
        const updated: SessionAcpMeta = {
          ...LEGACY_META,
          runtimeSessionName: "current-runtime",
          lastActivityAt: 40,
        };
        await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => updated });
        expect(readAcpSessionMeta(fixture.acpScope)).toEqual(updated);
        reopenDatabases();

        expect((await fixture.migrateAcp()).warnings).toEqual([]);
        expect(readAcpSessionMeta(fixture.acpScope)).toEqual(updated);
        expect((await listAcpSessionEntries(fixture.acpScope)).map((entry) => entry.acp)).toEqual([
          updated,
        ]);
        fixture.assertOriginalsRetained();
        await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => null });
        reopenDatabases();
        expect((await fixture.migrateAcp()).warnings).toEqual([]);
        expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
      });
    },
  );

  it.each([false, true])(
    "preserves canonical session deletion (prior ACP import: %s)",
    async (priorImport) => {
      await withOpenClawTestState({ label: "retained-acp-deletion" }, async (state) => {
        const fixture = await seedRetainedSource(state);
        if (priorImport) {
          expect((await fixture.migrateAcp()).warnings).toEqual([]);
        }
        expect((await fixture.importCore()).totals.importedEntries).toBe(1);
        await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => null });
        await deleteSessionEntryLifecycle({
          ...fixture.scope,
          target: { canonicalKey: SESSION_KEY, storeKeys: [SESSION_KEY] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        expect(loadExactSessionEntry(fixture.scope)).toBeUndefined();
        reopenDatabases();

        expect((await fixture.migrateAcp()).warnings).toEqual([]);
        expect(loadExactSessionEntry(fixture.scope)).toBeUndefined();
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT count(*) AS count FROM acp_sessions")
            .get(),
        ).toEqual({ count: 0 });
        fixture.assertOriginalsRetained();
      });
    },
  );

  it.each([
    { binding: "sessionId", initialRevision: undefined },
    { binding: "lifecycleRevision", initialRevision: "00000000-0000-4000-8000-000000000007" },
    { binding: "lifecycleRevision", initialRevision: undefined },
  ] as const)(
    "does not first-import ACP after the canonical $binding was replaced (source revision: $initialRevision)",
    async ({ binding, initialRevision }) => {
      await withOpenClawTestState({ label: "retained-acp-replaced" }, async (state) => {
        const fixture = await seedRetainedSource(state, initialRevision);
        expect((await fixture.importCore()).totals.importedEntries).toBe(1);
        const original = loadExactSessionEntry(fixture.scope)?.entry;
        expect(original).toBeDefined();
        if (!original) {
          throw new Error("Canonical session was not imported");
        }
        await replaceSessionEntry(fixture.scope, {
          ...original,
          [binding]:
            binding === "sessionId"
              ? "replacement-session"
              : "00000000-0000-4000-8000-000000000008",
        });
        reopenDatabases();
        expect((await fixture.migrateAcp()).warnings).toEqual([]);
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT count(*) AS count FROM acp_sessions")
            .get(),
        ).toEqual({ count: 0 });
        await replaceSessionEntry(fixture.scope, original);
        reopenDatabases();
        expect((await fixture.migrateAcp()).warnings).toEqual([]);
        expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
        fixture.assertOriginalsRetained();
      });
    },
  );

  it("does not infer an unconsumed ACP import when recorded provenance is null", async () => {
    await withOpenClawTestState({ label: "retained-acp-unknown-provenance" }, async (state) => {
      const fixture = await seedRetainedSource(state);
      expect((await fixture.importCore()).totals.importedEntries).toBe(1);
      const { db } = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      db.prepare(
        "UPDATE session_nodes SET legacy_acp_migration_json = NULL WHERE session_key = ?",
      ).run(SESSION_KEY);
      await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => null });
      reopenDatabases();
      await expect(fixture.migrateAcp()).rejects.toThrow("no matching recorded source provenance");
      expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
      fixture.assertOriginalsRetained();
    });
  });

  it("refuses changed retained ACP inputs without replaying a closed binding", async () => {
    await withOpenClawTestState({ label: "retained-acp-source-conflict" }, async (state) => {
      const fixture = await seedRetainedSource(state);
      expect((await fixture.migrateAcp()).warnings).toEqual([]);
      expect((await fixture.importCore()).totals.importedEntries).toBe(1);
      await upsertAcpSessionMeta({ ...fixture.acpScope, mutate: () => null });
      const changed = fs
        .readFileSync(fixture.scope.storePath, "utf8")
        .replace("legacy-runtime", "changed-source-runtime");
      fs.writeFileSync(fixture.scope.storePath, changed);
      reopenDatabases();

      await expect(fixture.migrateAcp()).rejects.toThrow("Retained ACP metadata changed");
      expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
      expect(fs.readFileSync(fixture.scope.storePath, "utf8")).toBe(changed);
    });
  });

  it("rolls back ACP metadata if its import receipt cannot be committed", async () => {
    await withOpenClawTestState({ label: "retained-acp-receipt-rollback" }, async (state) => {
      const fixture = await seedRetainedSource(state);
      expect((await fixture.importCore()).totals.importedEntries).toBe(1);
      const { db } = openOpenClawStateDatabase({ env: state.env });
      const receiptsBefore = db
        .prepare("SELECT * FROM migration_sources ORDER BY source_key")
        .all();
      const runsBefore = db.prepare("SELECT * FROM migration_runs ORDER BY id").all();
      db.exec(
        "CREATE TRIGGER reject_acp_receipt BEFORE INSERT ON migration_sources BEGIN SELECT RAISE(ABORT, 'injected ACP receipt failure'); END",
      );
      try {
        await expect(fixture.migrateAcp()).rejects.toThrow("injected ACP receipt failure");
        expect(readAcpSessionMeta(fixture.acpScope)).toBeUndefined();
        expect(db.prepare("SELECT count(*) AS count FROM acp_sessions").get()).toEqual({
          count: 0,
        });
        expect(db.prepare("SELECT * FROM migration_sources ORDER BY source_key").all()).toEqual(
          receiptsBefore,
        );
        expect(db.prepare("SELECT * FROM migration_runs ORDER BY id").all()).toEqual(runsBefore);
        fixture.assertOriginalsRetained();
      } finally {
        db.exec("DROP TRIGGER reject_acp_receipt");
      }

      expect((await fixture.migrateAcp()).warnings).toEqual([]);
      expect(readAcpSessionMeta(fixture.acpScope)).toEqual(LEGACY_META);
      fixture.assertOriginalsRetained();
    });
  });
});
