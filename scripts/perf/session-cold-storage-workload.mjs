// Actual serving-Gateway archive/status owner workload for session-reader-preparation-measure.
// The caller seeds 5,000 sessions. Preparation archives distinct synthetic transcripts once;
// each measured restore consumes one, so cooldown/fixture writes never enter its timing window.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export async function prepareColdStorageWorkload({
  load,
  root,
  options,
  databasePath,
  iterations,
  operation,
}) {
  const count = 50 + 20 * iterations;
  assert(
    operation === "state-read" || operation === "page-prune" || count <= 5000,
    "Cold restore controls must fit the 5,000-session fixture",
  );
  const { acquireGatewayStateOwner } = await load("src/infra/gateway-state-owner.ts");
  const { readGatewayLockProcessNamespace } = await load("src/infra/gateway-lock-payload.ts");
  const { resolveOpenClawStateSqlitePath } = await load("src/state/openclaw-state-db.paths.ts");
  const lease = acquireGatewayStateOwner({
    databasePath: resolveOpenClawStateSqlitePath(options.env),
    payload: {
      pid: process.pid,
      role: "gateway",
      createdAt: new Date().toISOString(),
      configPath: path.join(root, "openclaw.json"),
      processNamespace: readGatewayLockProcessNamespace(),
    },
  });
  if (operation === "state-read") {
    try {
      const { openOpenClawStateDatabase } = await load("src/state/openclaw-state-db.ts");
      const { retainOpenClawStateDatabaseForIdle } = await load(
        "src/state/openclaw-state-db-cache.ts",
      );
      const { executeExistingOpenClawStateRead } = await load(
        "src/state/openclaw-state-db-readonly.ts",
      );
      const database = openOpenClawStateDatabase({ env: options.env });
      const releaseIdle = retainOpenClawStateDatabaseForIdle(database);
      return {
        prepareMeasurement: () => lease.run(() => lease.assertCurrent()),
        async cycle() {
          assert(database.db.isOpen, "The measured read must retain its cached native handle");
          assert.deepEqual(
            await executeExistingOpenClawStateRead(
              { path: database.path, env: options.env },
              { type: "backup.runs" },
            ),
            { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] },
          );
        },
        verify: () => assert(database.db.isOpen),
        release() {
          releaseIdle();
          lease.release();
        },
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  const { openOpenClawAgentDatabase, runOpenClawAgentWriteTransaction } = await load(
    "src/state/openclaw-agent-db.ts",
  );
  if (operation === "page-prune") {
    try {
      return await preparePagePruningWorkload({
        load,
        options,
        databasePath,
        iterations,
        lease,
        openOpenClawAgentDatabase,
        runOpenClawAgentWriteTransaction,
      });
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  const { resolveSqliteTranscriptScope } = await load(
    "src/config/sessions/session-accessor.sqlite-scope.ts",
  );
  const { replaceSqliteTranscriptEventsInTransaction } = await load(
    "src/config/sessions/session-accessor.sqlite-transcript-store.ts",
  );
  const { loadTranscriptEventsSync } = await load(
    "src/config/sessions/session-accessor.sqlite-read.ts",
  );
  const { restoreSessionColdTranscript, runSessionColdStorageMaintenance } = await load(
    "src/config/sessions/session-cold-storage.ts",
  );
  const { getSessionColdStorageStatus } = await load(
    "src/config/sessions/session-cold-storage-status.ts",
  );
  const { readSessionColdStorageInventory } = await load(
    "src/config/sessions/session-cold-storage-inventory.ts",
  );
  const config = {
    agents: { entries: { synthetic: {} } },
    session: {
      store: databasePath,
      maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
    },
  };
  const scope = (index) => ({
    ...options,
    storePath: databasePath,
    sessionKey: `agent:synthetic:session-${index}`,
    sessionId: `synthetic-${index}`,
  });
  const events = (index) => [
    { type: "session", id: `synthetic-${index}`, version: 3 },
    {
      type: "message",
      id: `synthetic-message-${index}`,
      parentId: null,
      message: { role: "user", content: "Synthetic archived history 🦞\n".repeat(2048) },
    },
  ];
  try {
    for (let index = 0; index < count; index++) {
      const target = resolveSqliteTranscriptScope(scope(index));
      runOpenClawAgentWriteTransaction((database) => {
        replaceSqliteTranscriptEventsInTransaction(database, target, events(index));
      }, options);
    }
    runOpenClawAgentWriteTransaction(({ db }) => {
      // sqlite-allow-raw -- Synthetic fixture age, outside all measured operations.
      db.exec("UPDATE session_windows SET updated_at=1, transcript_updated_at=1");
    }, options);
    let archived = 0;
    while (archived < count) {
      const result = await runSessionColdStorageMaintenance({ config });
      assert(result.archivedTranscripts > 0, "Synthetic cold preparation made no progress");
      archived += result.archivedTranscripts;
    }
    assert.equal(archived, count);
    let restored = 0;
    return {
      cycle:
        operation === "cold-status"
          ? async () => {
              const status = await getSessionColdStorageStatus(config);
              assert.equal(
                status.reduce((sum, value) => sum + value.coldTranscripts, 0),
                count,
              );
            }
          : async () => {
              assert(restored < count, "Cold controls exhausted their prearchived transcripts");
              await restoreSessionColdTranscript(scope(restored++));
            },
      verify() {
        const inventory = readSessionColdStorageInventory(openOpenClawAgentDatabase(options));
        assert.equal(inventory.coldTranscripts, count - restored);
        for (let index = 0; index < restored; index++) {
          assert.deepEqual(loadTranscriptEventsSync(scope(index)), events(index));
        }
      },
      release: () => lease.release(),
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

// Each window owns one real pruning pass; fixture SQL and durable checks run outside it.
async function preparePagePruningWorkload({
  load,
  options,
  databasePath,
  iterations,
  lease,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
}) {
  assert.equal(iterations, 1, "Page pruning measures one prepared pass per window");
  const { ensureSessionTranscriptArchiveSchema } = await load(
    "src/state/openclaw-agent-session-transcript-archive-schema.ts",
  );
  const { resolveRegisteredSqliteTranscriptArchiveName } = await load(
    "src/config/sessions/session-accessor.sqlite-archive-artifact.ts",
  );
  const { resolveSessionArtifactDirectory } = await load("src/config/sessions/paths.ts");
  const { pruneAllSessionTranscriptArchivesToHighWater } = await load(
    "src/config/sessions/session-history-archive-pruning.ts",
  );
  const archiveDirectory = resolveSessionArtifactDirectory(databasePath);
  const archiveName = resolveRegisteredSqliteTranscriptArchiveName({
    createdAt: 1,
    encoding: "identity",
    generation: "synthetic-page-generation",
    reason: "deleted",
    sessionId: "synthetic-page-history",
  });
  const archivePath = path.join(archiveDirectory, archiveName);
  const content = Buffer.alloc(256 * 1024, "synthetic retained history\n");
  const digest = createHash("sha256").update(content).digest("hex");
  const databaseOptions = { ...options, path: databasePath };
  const database = () => openOpenClawAgentDatabase(databaseOptions);
  const rowCount = () =>
    database().db.prepare("SELECT count(*) AS n FROM session_transcript_archives").get().n;
  const pragma = (name) => Object.values(database().db.prepare(`PRAGMA ${name}`).get())[0];
  let prepared;
  let initialLayout;
  let diagnostics;
  let result;
  let verified = true;
  return {
    warmupIterations: 3,
    prepareWindow() {
      runOpenClawAgentWriteTransaction((current) => {
        ensureSessionTranscriptArchiveSchema(current.db);
        assert.equal(
          current.db.prepare("SELECT count(*) AS n FROM session_transcript_archives").get().n,
          0,
          "Previous pruning pass left archive rows",
        );
        // sqlite-allow-raw -- Identical synthetic archive, outside all measured windows.
        current.db
          .prepare(`INSERT INTO session_transcript_archives
          (archive_blob, archive_name, archive_sha256, created_at, encoding, generation,
           published_at, reason, session_id, session_key)
          VALUES (?, ?, ?, 1, 'identity', 'synthetic-page-generation', 1, 'deleted',
                  'synthetic-page-history', 'agent:synthetic:session-42')`)
          .run(content, archiveName, digest);
      }, databaseOptions);
      fs.mkdirSync(archiveDirectory, { recursive: true });
      fs.writeFileSync(archivePath, content);
      // Normalize layout and WAL outside the window so each pass deletes equal page work.
      database().db.exec("VACUUM");
      database().db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      prepared = {
        archives: rowCount(),
        archiveBytes: fs.statSync(archivePath).size,
        pageSize: pragma("page_size"),
        pageCount: pragma("page_count"),
        freePages: pragma("freelist_count"),
      };
      initialLayout ??= prepared;
      diagnostics = { trigger: "initial" };
      result = undefined;
      return prepared;
    },
    async cycle() {
      result = await pruneAllSessionTranscriptArchivesToHighWater({
        databaseOptions,
        archiveDirectory,
        highWaterBytes: 0,
        storePath: databasePath,
        diagnostics,
      });
    },
    verifyWindow() {
      const work = {
        prepared,
        matchesInitialLayout: JSON.stringify(prepared) === JSON.stringify(initialLayout),
        removedFiles: result.removedFiles,
        remainingRows: rowCount(),
        archiveExists: fs.existsSync(archivePath),
        checkpointIncomplete: result.checkpointIncomplete,
        checkpointCalls: diagnostics.checkpointCalls ?? 0,
        vacuumPasses: diagnostics.vacuumPasses ?? 0,
        vacuumPagesRequested: diagnostics.vacuumPagesRequested ?? 0,
        freePagesAfter: pragma("freelist_count"),
        pageCountAfter: pragma("page_count"),
      };
      work.verified =
        work.matchesInitialLayout &&
        work.prepared.archives === 1 &&
        work.prepared.archiveBytes === content.length &&
        work.removedFiles === 1 &&
        work.remainingRows === 0 &&
        !work.archiveExists &&
        work.checkpointIncomplete === 0;
      verified &&= work.verified;
      return work;
    },
    verify: () => assert(verified, "Page pruning controls contain a work mismatch"),
    release: () => lease.release(),
  };
}
