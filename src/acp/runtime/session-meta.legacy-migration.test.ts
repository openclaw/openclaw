import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { repairCanonicalSessionKeys } from "../../commands/doctor-session-canonical-keys.js";
import { runDoctorSessionSqlite } from "../../commands/doctor-session-sqlite.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../../infra/deferred-plugin-migrations.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { migrateLegacyAcpSessionMetadata } from "../../infra/state-migrations.session-store.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { createAcpMeta } from "./session-meta-lifecycle.test-support.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  upsertAcpSessionMeta,
} from "./session-meta.js";

const SESSION_KEY = "agent:main:retained-acp";
const SESSION_ID = "retained-acp-session";
const PLUGIN_ID = "fixture-plugin";
const SOURCE_REVISION = "00000000-0000-4000-8000-000000000007";
const LEGACY_META = createAcpMeta({
  backend: "fixture-backend",
  runtimeSessionName: "legacy-runtime",
  lastActivityAt: 20,
});

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
      { type: "message", id: "m", parentId: null, message: { role: "user", content: "x" } },
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
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  await state.writeConfig(cfg);
  await recordDeferredPluginMigrations({
    env: state.env,
    pending: [
      {
        pluginId: PLUGIN_ID,
        reason: "The configured plugin is not installed.",
        command: "openclaw plugins install @example/fixture-plugin",
      },
    ],
  });
  const assertOriginalsRetained = preserveFiles([storePath, transcriptPath]);
  const scope = { agentId: "main", storePath, env: state.env, sessionKey: SESSION_KEY };
  const acpScope = { cfg, env: state.env, agentId: "main", sessionKey: SESSION_KEY };
  const migrateAcp = async (reopen = false) => {
    if (reopen) {
      await reopenDatabases();
    }
    const result = await migrateLegacyAcpSessionMetadata({
      cfg,
      env: state.env,
      pluginSessionStoreAgentIds: [],
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.warnings).toEqual([]);
    return result;
  };
  const readMeta = () => readAcpSessionEntry(acpScope)?.acp;
  const write = (meta: SessionAcpMeta | null, assertCommitAllowed?: () => void) =>
    upsertAcpSessionMeta({ ...acpScope, mutate: () => meta, assertCommitAllowed });
  const receipts = () => {
    const { db } = openOpenClawStateDatabase({ env: state.env });
    return {
      sources: db.prepare("SELECT * FROM migration_sources ORDER BY source_key").all(),
      runs: db.prepare("SELECT * FROM migration_runs ORDER BY id").all(),
    };
  };
  const reopenAndExpect = async (meta?: SessionAcpMeta) => {
    await migrateAcp(true);
    expect(readMeta()).toEqual(meta);
  };
  const importCore = () =>
    runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
  // Resolving the plugin lets the next core import archive and remove the retained originals.
  const archiveCoreSources = async () => {
    await recordDeferredPluginMigrations({
      env: state.env,
      pending: [],
      resolvedPluginIds: [PLUGIN_ID],
    });
    await reopenDatabases();
    const imported = await importCore();
    expect(imported.targets.flatMap((target) => target.issues)).toEqual([]);
    expect(fs.existsSync(storePath)).toBe(false);
    const archives = imported.targets.flatMap((target) =>
      (target.archivedLegacyStoreFiles ?? []).concat(target.archivedTranscriptFiles),
    );
    expect(archives.length).toBeGreaterThan(0);
    const assertArchives = preserveFiles(archives);
    return () => {
      assertArchives();
      expect(fs.existsSync(storePath)).toBe(false);
    };
  };
  return {
    scope,
    acpScope,
    migrateAcp,
    reopenAndExpect,
    readMeta,
    write,
    receipts,
    importCore,
    assertOriginalsRetained,
    archiveCoreSources,
  };
}

function preserveFiles(files: string[]) {
  const originals = files.map((file) => [file, fs.readFileSync(file)] as const);
  return () => {
    for (const [file, original] of originals) {
      expect(fs.readFileSync(file)).toEqual(original);
    }
  };
}

async function reopenDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

it("preserves canonical closure after a session-key repair and repair rerun", async () => {
  await withOpenClawTestState({ label: "retained-acp-key-repair" }, async (state) => {
    const f = await seedRetainedSource(state, undefined, SESSION_KEY.toUpperCase());
    expect((await f.importCore()).totals.importedEntries).toBe(1);
    const repairKeys = () =>
      repairCanonicalSessionKeys({ apply: true, cfg: f.acpScope.cfg, env: state.env });
    expect((await repairKeys()).repairedGroups).toBe(1);
    expect((await repairKeys()).repairedGroups).toBe(0);
    await f.write({ ...LEGACY_META, runtimeSessionName: "canonical-runtime" });
    await f.write(null);
    await f.reopenAndExpect();
    f.assertOriginalsRetained();
  });
});

it.each(["initialize", "close"] as const)(
  "rolls back canonical ACP %s and source consumption when commit authority is revoked",
  async (operation) => {
    await withOpenClawTestState({ label: `retained-acp-atomic-${operation}` }, async (state) => {
      const f = await seedRetainedSource(state);
      expect((await f.importCore()).totals.importedEntries).toBe(1);
      const canonicalMeta = { ...LEGACY_META, runtimeSessionName: "canonical-runtime" };
      if (operation === "close") {
        seedCanonicalAcpSessionMeta({
          ...f.acpScope,
          sessionId: SESSION_ID,
          meta: canonicalMeta,
        });
      }
      const nextMeta = operation === "close" ? null : canonicalMeta;
      const before = f.readMeta();
      const beforeReceipts = f.receipts();
      const revoked = new Error("Canonical ACP commit authority revoked");
      let current = true;
      let observedCommit = false;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const admission = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) => {
          return createAdmission((request, grant) => {
            if (
              request.stage === "commit" &&
              isRecord(request.facts) &&
              isRecord(request.facts.facts) &&
              request.facts.facts.kind === "acp"
            ) {
              // Both receipt and metadata writes precede this final admission.
              expect(request.facts.facts.acp).toEqual(nextMeta);
              observedCommit = true;
              current = false;
            }
            admit(request, grant);
          }, attachment);
        });
      try {
        await expect(
          f.write(nextMeta, () => {
            if (!current) {
              throw revoked;
            }
          }),
        ).rejects.toThrow(revoked.message);
        expect(observedCommit).toBe(true);
        expect(f.readMeta()).toEqual(before);
        expect(f.receipts()).toEqual(beforeReceipts);
        f.assertOriginalsRetained();
      } finally {
        admission.mockRestore();
        current = true;
      }
      await f.write(nextMeta);
      await f.write(null);
      await f.reopenAndExpect();
      f.assertOriginalsRetained();
    });
  },
);

it("does not revive closed ACP metadata after reopening and settling the plugin migration", async () => {
  await withOpenClawTestState({ label: "retained-acp-close-resolved" }, async (state) => {
    const f = await seedRetainedSource(state);
    await f.migrateAcp();
    expect((await f.importCore()).totals.importedEntries).toBe(1);
    expect(f.readMeta()).toEqual(LEGACY_META);

    await f.write(null);
    expect(loadExactSessionEntry(f.scope)?.entry.sessionId).toBe(SESSION_ID);
    expect(f.readMeta()).toBeUndefined();
    f.assertOriginalsRetained();
    await recordDeferredPluginMigrations({
      env: state.env,
      pending: [],
      resolvedPluginIds: [PLUGIN_ID],
    });
    await f.migrateAcp(true);
    expect(loadExactSessionEntry(f.scope)?.entry.sessionId).toBe(SESSION_ID);
    expect(f.readMeta()).toBeUndefined();
    expect(await listAcpSessionEntries(f.acpScope)).toEqual([]);
    f.assertOriginalsRetained();
    const settled = await f.importCore();
    expect(settled.totals.importedEntries).toBe(0);
    expect(settled.targets.flatMap((target) => target.issues)).toEqual([]);
    expect(fs.existsSync(f.scope.storePath)).toBe(false);
    expect(f.readMeta()).toBeUndefined();
  });
});

it("keeps import completion bound to the ACP lifecycle when the legacy session id changes", async () => {
  await withOpenClawTestState({ label: "retained-acp-lifecycle" }, async (state) => {
    const f = await seedRetainedSource(state, SOURCE_REVISION);
    await f.migrateAcp();
    expect((await f.importCore()).totals.importedEntries).toBe(1);
    expect(loadExactSessionEntry(f.scope)?.entry.lifecycleRevision).toBe(SOURCE_REVISION);
    await f.write(null);
    const changed = fs
      .readFileSync(f.scope.storePath, "utf8")
      .replace(SESSION_ID, "rekeyed-source-session");
    fs.writeFileSync(f.scope.storePath, changed);
    await f.reopenAndExpect();
    expect(fs.readFileSync(f.scope.storePath, "utf8")).toBe(changed);
  });
});

it("preserves canonical ACP edits before the first import", async () => {
  await withOpenClawTestState({ label: "retained-acp-edit" }, async (state) => {
    const f = await seedRetainedSource(state);
    expect((await f.importCore()).totals.importedEntries).toBe(1);
    const updated: SessionAcpMeta = {
      ...LEGACY_META,
      runtimeSessionName: "current-runtime",
      lastActivityAt: 40,
    };
    await f.write(updated);
    expect(f.readMeta()).toEqual(updated);
    await f.reopenAndExpect(updated);
    expect((await listAcpSessionEntries(f.acpScope)).map((entry) => entry.acp)).toEqual([updated]);
    f.assertOriginalsRetained();
    await f.write(null);
    await f.reopenAndExpect();
  });
});

it("imports retained ACP metadata after core session sources are archived", async () => {
  await withOpenClawTestState({ label: "retained-acp-archived-source" }, async (state) => {
    const f = await seedRetainedSource(state);
    expect((await f.importCore()).totals.importedEntries).toBe(1);
    f.assertOriginalsRetained();

    const assertArchivesRetained = await f.archiveCoreSources();
    await f.reopenAndExpect(LEGACY_META);
    await reopenDatabases();
    expect((await f.migrateAcp()).changes).toEqual([]);
    await f.write(null);
    await f.reopenAndExpect();
    assertArchivesRetained();
  });
});

it.each(
  (["retained", "archived"] as const).flatMap((sourceMode) => [
    { binding: "sessionId" as const, initialRevision: undefined, sourceMode },
    { binding: "lifecycleRevision" as const, initialRevision: SOURCE_REVISION, sourceMode },
  ]),
)(
  "does not first-import ACP after the canonical $binding was replaced ($sourceMode, source revision: $initialRevision)",
  async ({ binding, initialRevision, sourceMode }) => {
    await withOpenClawTestState({ label: "retained-acp-replaced" }, async (state) => {
      const f = await seedRetainedSource(state, initialRevision);
      expect((await f.importCore()).totals.importedEntries).toBe(1);
      const assertSourcesRetained =
        sourceMode === "archived" ? await f.archiveCoreSources() : f.assertOriginalsRetained;
      const original = loadExactSessionEntry(f.scope)!.entry;
      await replaceSessionEntry(f.scope, {
        ...original,
        [binding]:
          binding === "sessionId" ? "replacement-session" : "00000000-0000-4000-8000-000000000008",
      });
      await f.migrateAcp(true);
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT count(*) AS count FROM acp_sessions")
          .get(),
      ).toEqual({ count: 0 });
      await replaceSessionEntry(f.scope, original);
      await f.reopenAndExpect();
      assertSourcesRetained();
    });
  },
);

it("does not infer an unconsumed ACP import when recorded provenance is null", async () => {
  await withOpenClawTestState({ label: "retained-acp-unknown-provenance" }, async (state) => {
    const f = await seedRetainedSource(state);
    expect((await f.importCore()).totals.importedEntries).toBe(1);
    const { db } = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    db.prepare(
      "UPDATE session_nodes SET legacy_acp_migration_json = NULL WHERE session_key = ?",
    ).run(SESSION_KEY);
    await f.write(null);
    await reopenDatabases();
    await expect(f.migrateAcp()).rejects.toThrow("no matching recorded source provenance");
    expect(f.readMeta()).toBeUndefined();
    f.assertOriginalsRetained();
  });
});

it("rolls back ACP metadata if its import receipt cannot be committed", async () => {
  await withOpenClawTestState({ label: "retained-acp-receipt-rollback" }, async (state) => {
    const f = await seedRetainedSource(state);
    expect((await f.importCore()).totals.importedEntries).toBe(1);
    const { db } = openOpenClawStateDatabase({ env: state.env });
    const beforeReceipts = f.receipts();
    db.exec(
      "CREATE TRIGGER reject_acp_receipt BEFORE INSERT ON migration_sources BEGIN SELECT RAISE(ABORT, 'injected ACP receipt failure'); END",
    );
    try {
      await expect(f.migrateAcp()).rejects.toThrow("injected ACP receipt failure");
      expect(f.readMeta()).toBeUndefined();
      expect(db.prepare("SELECT count(*) AS count FROM acp_sessions").get()).toEqual({
        count: 0,
      });
      expect(f.receipts()).toEqual(beforeReceipts);
      f.assertOriginalsRetained();
    } finally {
      db.exec("DROP TRIGGER reject_acp_receipt");
    }

    await f.migrateAcp();
    expect(f.readMeta()).toEqual(LEGACY_META);
    f.assertOriginalsRetained();
  });
});
