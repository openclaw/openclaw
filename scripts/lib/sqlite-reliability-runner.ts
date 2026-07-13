import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../../src/infra/node-sqlite.js";
import { createLocalSqliteSnapshotProvider } from "../../src/snapshot/local-repository.js";
import type { SnapshotDatabaseIdentity } from "../../src/snapshot/snapshot-provider.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.js";
import {
  COMMITTED_WAL_SENTINEL,
  PROFILES,
  STRESS_TABLE_SQL,
  type CliOptions,
  type ReliabilityReport,
} from "./sqlite-reliability-contract.js";
import {
  startWriter,
  stopWriter,
  terminateWriter,
  waitForWriterMessage,
  type WriterHandle,
} from "./sqlite-reliability-writer.js";

type TargetDatabase = {
  identity: SnapshotDatabaseIdentity;
  label: string;
  path: string;
};

type IterationMetric = {
  restoreMs: number;
  snapshotBytes: number;
  snapshotMs: number;
};

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}

function fileSize(pathname: string): number {
  try {
    return fs.statSync(pathname).size;
  } catch {
    return 0;
  }
}

function resolveTargetDatabase(options: CliOptions, env: NodeJS.ProcessEnv): TargetDatabase {
  if (options.agentId) {
    const database = openOpenClawAgentDatabase({ agentId: options.agentId, env });
    const target = {
      identity: { role: "agent", agentId: database.agentId } as const,
      label: `agent:${database.agentId}`,
      path: database.path,
    };
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    return target;
  }
  const database = openOpenClawStateDatabase({ env });
  const target = {
    identity: { role: "global" } as const,
    label: "global",
    path: database.path,
  };
  closeOpenClawStateDatabaseForTest();
  return target;
}

function setupStressTable(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA busy_timeout = 30000;");
    database.exec(STRESS_TABLE_SQL);
    database.prepare("DELETE FROM openclaw_reliability_entries").run();
    database.prepare("DELETE FROM openclaw_reliability_sentinel").run();
  } finally {
    database.close();
  }
}

function copySnapshotDirectory(sourcePath: string, syncedRepository: string): string {
  fs.mkdirSync(syncedRepository, { recursive: true, mode: 0o700 });
  const destinationPath = path.join(syncedRepository, path.basename(sourcePath));
  fs.cpSync(sourcePath, destinationPath, {
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  return destinationPath;
}

function assertPragmaOk(database: DatabaseSync, pragma: "integrity_check" | "quick_check"): void {
  const rows = database.prepare(`PRAGMA ${pragma};`).all() as Array<Record<string, unknown>>;
  const messages = rows.map((row) => row[pragma]);
  if (messages.length !== 1 || messages[0] !== "ok") {
    throw new Error(`${pragma} failed: ${messages.map(String).join("; ")}`);
  }
}

function verifyRestoredDatabase(params: {
  identity: SnapshotDatabaseIdentity;
  path: string;
  rowsPerBatch: number;
  uncommittedBatch: number | null;
}): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(params.path, { readOnly: true });
  try {
    database.exec("PRAGMA trusted_schema = OFF;");
    assertPragmaOk(database, "quick_check");
    assertPragmaOk(database, "integrity_check");
    const foreignKeys = database.prepare("PRAGMA foreign_key_check;").all();
    if (foreignKeys.length > 0) {
      throw new Error(`foreign_key_check failed with ${foreignKeys.length} row(s)`);
    }
    if (params.identity.role === "global") {
      assertOpenClawStateDatabaseForMaintenance(database, { pathname: params.path });
    } else if (params.identity.role === "agent") {
      assertOpenClawAgentDatabaseForMaintenance(database, {
        agentId: params.identity.agentId,
        pathname: params.path,
      });
    }
    const sentinel = database
      .prepare("SELECT payload FROM openclaw_reliability_sentinel WHERE id = 1")
      .get() as { payload?: unknown } | undefined;
    if (sentinel?.payload !== COMMITTED_WAL_SENTINEL) {
      throw new Error("committed WAL sentinel is missing after restore");
    }
    const partial = database
      .prepare(
        `SELECT batch, COUNT(*) AS row_count
           FROM openclaw_reliability_entries
          GROUP BY batch
         HAVING COUNT(*) <> ?
          LIMIT 1`,
      )
      .get(params.rowsPerBatch) as { batch?: unknown; row_count?: unknown } | undefined;
    if (partial) {
      throw new Error(
        `partial transaction visible after restore: batch=${String(partial.batch)} rows=${String(partial.row_count)}`,
      );
    }
    if (params.uncommittedBatch !== null) {
      const held = database
        .prepare("SELECT COUNT(*) AS rows FROM openclaw_reliability_entries WHERE batch = ?")
        .get(params.uncommittedBatch) as { rows?: unknown };
      if (Number(held.rows) !== 0) {
        throw new Error(
          `uncommitted transaction became visible after restore: batch=${params.uncommittedBatch} rows=${String(held.rows)}`,
        );
      }
    }
  } finally {
    database.close();
  }
}

async function runSnapshotIteration(params: {
  iteration: number;
  repositoryProvider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  restoreRoot: string;
  rowsPerBatch: number;
  syncedProvider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  syncedRepository: string;
  target: TargetDatabase;
  uncommittedBatch: number | null;
}): Promise<IterationMetric> {
  const snapshotStarted = nowMs();
  const snapshot = await params.repositoryProvider.create({
    identity: params.target.identity,
    path: params.target.path,
  });
  const snapshotMs = nowMs() - snapshotStarted;
  const copiedPath = copySnapshotDirectory(snapshot.ref.path, params.syncedRepository);
  const copiedRef = { path: copiedPath };
  await params.syncedProvider.verify(copiedRef);
  const restorePath = path.join(params.restoreRoot, `restore-${params.iteration}.sqlite`);
  const restoreStarted = nowMs();
  await params.syncedProvider.restoreFresh(copiedRef, restorePath);
  const restoreMs = nowMs() - restoreStarted;
  verifyRestoredDatabase({
    identity: params.target.identity,
    path: restorePath,
    rowsPerBatch: params.rowsPerBatch,
    uncommittedBatch: params.uncommittedBatch,
  });
  return {
    restoreMs: Number(restoreMs.toFixed(3)),
    snapshotBytes: snapshot.manifest.artifact.sizeBytes,
    snapshotMs: Number(snapshotMs.toFixed(3)),
  };
}

export async function runReliabilityStress(options: CliOptions): Promise<ReliabilityReport> {
  const profile = PROFILES[options.profile];
  const ownsStateDir = options.stateDir === null;
  const stateDir =
    options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-reliability-"));
  const repository = options.repository ?? path.join(stateDir, "snapshots");
  const runScratch = path.join(stateDir, "sqlite-reliability-runs", randomUUID());
  const syncedRepository = path.join(runScratch, "synced-snapshots");
  const validationRoot = path.join(runScratch, "snapshot-validation");
  const restoreRoot = path.join(runScratch, "restored");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const started = nowMs();
  let writer: WriterHandle | undefined;
  try {
    fs.mkdirSync(validationRoot, { recursive: true, mode: 0o700 });
    const target = resolveTargetDatabase(options, env);
    setupStressTable(target.path);
    const repositoryProvider = createLocalSqliteSnapshotProvider({
      repositoryPath: repository,
      validationRootPath: validationRoot,
    });
    const syncedProvider = createLocalSqliteSnapshotProvider({
      repositoryPath: syncedRepository,
      validationRootPath: validationRoot,
    });
    writer = startWriter(target.path, profile);
    await waitForWriterMessage(writer, "ready");
    const walBytesBefore = fileSize(`${target.path}-wal`);
    const partial = await waitForWriterMessage(writer, "partial", () => {
      writer?.child.send?.({ kind: "hold-partial" });
    });
    const metrics: IterationMetric[] = [];
    for (let iteration = 0; iteration < profile.iterations; iteration += 1) {
      metrics.push(
        await runSnapshotIteration({
          iteration,
          repositoryProvider,
          restoreRoot,
          rowsPerBatch: profile.rowsPerBatch,
          syncedProvider,
          syncedRepository,
          target,
          uncommittedBatch: iteration === 0 ? partial.batch : null,
        }),
      );
      if (iteration === 0) {
        await waitForWriterMessage(writer, "released", () => {
          writer?.child.send?.({ action: "rollback", kind: "release-partial" });
        });
      }
    }
    const writerResult = await stopWriter(writer);
    const snapshotBytes = metrics.map((metric) => metric.snapshotBytes);
    return {
      arch: process.arch,
      iterations: profile.iterations,
      node: process.version,
      paths: {
        repository,
        sourceDatabase: target.path,
        stateDir,
        syncedRepository,
      },
      platform: process.platform,
      profile: options.profile,
      retainedBatches: profile.retainedBatches,
      restoresVerified: metrics.length,
      rowsPerBatch: profile.rowsPerBatch,
      snapshotBytes: {
        max: Math.max(...snapshotBytes),
        min: Math.min(...snapshotBytes),
      },
      target: target.label,
      timingsMs: {
        restoreP50: percentile(
          metrics.map((metric) => metric.restoreMs),
          50,
        ),
        restoreP95: percentile(
          metrics.map((metric) => metric.restoreMs),
          95,
        ),
        snapshotP50: percentile(
          metrics.map((metric) => metric.snapshotMs),
          50,
        ),
        snapshotP95: percentile(
          metrics.map((metric) => metric.snapshotMs),
          95,
        ),
        total: Number((nowMs() - started).toFixed(3)),
      },
      transactionProof: {
        committedWalSentinel: true,
        heldBatch: partial.batch,
        heldRows: partial.rows,
        visibleAfterRestore: false,
      },
      walBytes: {
        after: fileSize(`${target.path}-wal`),
        before: walBytesBefore,
      },
      writer: {
        batchesCommitted: writerResult.batchesCommitted,
        rowsCommitted: writerResult.rowsCommitted,
      },
    };
  } finally {
    if (writer && !writer.stopped) {
      await terminateWriter(writer);
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (ownsStateDir) {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  }
}
