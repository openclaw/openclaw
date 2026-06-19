// Snapshot stress benchmark exercises SQLite snapshots during concurrent writes.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../src/state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";

type ProfileId = "smoke" | "default" | "large";
type TargetRef =
  | { kind: "global" }
  | {
      agentId: string;
      kind: "agent";
    };

type ProfileConfig = {
  iterations: number;
  rowsPerBatch: number;
  writerPauseMs: number;
};

export type SnapshotStressOptions = {
  agentId: string | null;
  output: string | null;
  profile: ProfileId;
  repository: string | null;
  stateDir: string | null;
  target: TargetRef;
};

type IterationMetric = {
  restoreMs: number;
  snapshotBytes: number;
  snapshotMs: number;
};

type MetricSummary = {
  max: number;
  min: number;
  restoreP50: number;
  restoreP95: number;
  snapshotP50: number;
  snapshotP95: number;
  total: number;
};

export type SnapshotStressReport = {
  iterations: number;
  node: string;
  paths: {
    repository: string;
    sourceDatabase: string;
    stateDir: string;
  };
  profile: ProfileId;
  restoresVerified: number;
  rowsPerBatch: number;
  snapshotBytes: {
    max: number;
    min: number;
  };
  timingsMs: {
    restoreP50: number;
    restoreP95: number;
    snapshotP50: number;
    snapshotP95: number;
    total: number;
  };
  target: string;
  walBytes: {
    after: number;
    before: number;
  };
  writer: {
    batchesCommitted: number;
    rowsCommitted: number;
  };
};

type WriterData = {
  databasePath: string;
  rowsPerBatch: number;
  writerPauseMs: number;
};

type WriterReadyMessage = {
  kind: "ready";
};

type WriterResultMessage = {
  batchesCommitted: number;
  kind: "result";
  rowsCommitted: number;
};

type WriterErrorMessage = {
  error: string;
  kind: "error";
};

type WriterMessage = WriterErrorMessage | WriterReadyMessage | WriterResultMessage;

type WriterLifecycle = {
  finished: Promise<WriterResultMessage>;
  ready: Promise<void>;
  stop: () => void;
};

const PROFILES: Record<ProfileId, ProfileConfig> = {
  smoke: {
    iterations: 3,
    rowsPerBatch: 8,
    writerPauseMs: 25,
  },
  default: {
    iterations: 20,
    rowsPerBatch: 16,
    writerPauseMs: 10,
  },
  large: {
    iterations: 100,
    rowsPerBatch: 32,
    writerPauseMs: 5,
  },
};

const STRESS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS snapshot_stress_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(batch, ordinal)
  );
`;

const WRITER_WORKER_SOURCE = `
  const { DatabaseSync } = require("node:sqlite");
  const { parentPort, workerData } = require("node:worker_threads");

  const STRESS_TABLE_SQL = ${JSON.stringify(STRESS_TABLE_SQL)};

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function run() {
    const db = new DatabaseSync(workerData.databasePath);
    let stopped = false;
    let batchesCommitted = 0;
    let startBatch = 0;
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA busy_timeout = 30000;");
      db.exec(STRESS_TABLE_SQL);
      const nextBatchRow = db
        .prepare("SELECT COALESCE(MAX(batch), -1) + 1 AS nextBatch FROM snapshot_stress_entries")
        .get();
      startBatch = Number(nextBatchRow.nextBatch);
      batchesCommitted = startBatch;
      const insert = db.prepare(
        "INSERT INTO snapshot_stress_entries (batch, ordinal, payload) VALUES (?, ?, ?)",
      );
      parentPort.on("message", (message) => {
        if (message && message.kind === "stop") {
          stopped = true;
        }
      });
      parentPort.postMessage({ kind: "ready" });
      while (!stopped) {
        db.exec("BEGIN IMMEDIATE;");
        try {
          for (let ordinal = 0; ordinal < workerData.rowsPerBatch; ordinal += 1) {
            insert.run(
              batchesCommitted,
              ordinal,
              "batch-" + batchesCommitted + "-ordinal-" + ordinal,
            );
          }
          db.exec("COMMIT;");
          batchesCommitted += 1;
        } catch (error) {
          db.exec("ROLLBACK;");
          throw error;
        }
        if (workerData.writerPauseMs > 0) {
          await sleep(workerData.writerPauseMs);
        } else {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      parentPort.postMessage({
        batchesCommitted: batchesCommitted - startBatch,
        kind: "result",
        rowsCommitted: (batchesCommitted - startBatch) * workerData.rowsPerBatch,
      });
    } catch (error) {
      parentPort.postMessage({
        error: error instanceof Error ? error.message : String(error),
        kind: "error",
      });
    } finally {
      db.close();
    }
  }

  parentPort.once("message", (message) => {
    if (message && message.kind === "start") {
      void run();
    }
  });
`;

export function parseArgs(argv: string[]): SnapshotStressOptions {
  const defaults: SnapshotStressOptions = {
    agentId: null,
    output: null,
    profile: "default",
    repository: null,
    stateDir: null,
    target: { kind: "global" },
  };
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
        printUsage();
        process.exit(0);
        break;
      case "--profile":
        options.profile = parseProfile(requireFlagValue(argv, index, arg));
        index += 1;
        break;
      case "--state-dir":
        options.stateDir = requireFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--repository":
        options.repository = requireFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--output":
        options.output = requireFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--target": {
        const target = requireFlagValue(argv, index, arg);
        if (target !== "global") {
          throw new Error("--target must be global");
        }
        options.target = { kind: "global" };
        options.agentId = null;
        index += 1;
        break;
      }
      case "--agent": {
        const agentId = requireFlagValue(argv, index, arg).trim();
        if (!agentId) {
          throw new Error("--agent requires a non-empty value");
        }
        options.agentId = agentId;
        options.target = { agentId, kind: "agent" };
        index += 1;
        break;
      }
      default:
        if (arg.startsWith("--profile=")) {
          options.profile = parseProfile(arg.slice("--profile=".length));
        } else if (arg.startsWith("--state-dir=")) {
          options.stateDir = arg.slice("--state-dir=".length);
        } else if (arg.startsWith("--repository=")) {
          options.repository = arg.slice("--repository=".length);
        } else if (arg.startsWith("--output=")) {
          options.output = arg.slice("--output=".length);
        } else if (arg.startsWith("--target=")) {
          const target = arg.slice("--target=".length);
          if (target !== "global") {
            throw new Error("--target must be global");
          }
          options.target = { kind: "global" };
          options.agentId = null;
        } else if (arg.startsWith("--agent=")) {
          const agentId = arg.slice("--agent=".length).trim();
          if (!agentId) {
            throw new Error("--agent requires a non-empty value");
          }
          options.agentId = agentId;
          options.target = { agentId, kind: "agent" };
        } else {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }
  return options;
}

export function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

export function summarizeIterationMetrics(metrics: IterationMetric[]): MetricSummary {
  const snapshotBytes = metrics.map((metric) => metric.snapshotBytes);
  return {
    max: Math.max(...snapshotBytes, 0),
    min: snapshotBytes.length > 0 ? Math.min(...snapshotBytes) : 0,
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
    total: 0,
  };
}

function parseProfile(raw: string): ProfileId {
  if (raw === "smoke" || raw === "default" || raw === "large") {
    return raw;
  }
  throw new Error(`--profile must be one of smoke, default, large; got ${JSON.stringify(raw)}`);
}

function requireFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printUsage(): void {
  console.log(`OpenClaw snapshot SQLite stress benchmark

Usage:
  node --import tsx scripts/bench-snapshot-sqlite.mjs [options]

Options:
  --profile <smoke|default|large>  Stress profile (default: default)
  --target global                  Stress the shared OpenClaw state DB (default)
  --agent <id>                     Stress one per-agent database
  --state-dir <path>               Reuse a state directory instead of a temp dir
  --repository <path>              Snapshot repository path
  --output <path>                  Write machine-readable JSON report
  --help                           Show this text
`);
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function debug(message: string): void {
  if (process.env.SNAPSHOT_STRESS_DEBUG === "1") {
    console.error(`[snapshot-stress] ${message}`);
  }
}

function fileSize(pathname: string): number {
  try {
    return fs.statSync(pathname).size;
  } catch {
    return 0;
  }
}

function walSize(pathname: string): number {
  return fileSize(`${pathname}-wal`);
}

function setupStressTable(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 30000;");
    db.exec(STRESS_TABLE_SQL);
  } finally {
    db.close();
  }
}

function resolveTargetDatabase(
  options: SnapshotStressOptions,
  env: NodeJS.ProcessEnv,
): {
  id: string;
  kind: string;
  path: string;
  targetName: string;
} {
  if (options.target.kind === "agent") {
    const database = openOpenClawAgentDatabase({ agentId: options.target.agentId, env });
    const result = {
      id: `agent:${database.agentId}`,
      kind: "agent-data-plane",
      path: resolveOpenClawAgentSqlitePath({ agentId: database.agentId, env }),
      targetName: `agent:${database.agentId}`,
    };
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    return result;
  }
  openOpenClawStateDatabase({ env });
  const result = {
    id: "global",
    kind: "global-control-plane",
    path: resolveOpenClawStateSqlitePath(env),
    targetName: "global",
  };
  closeOpenClawStateDatabaseForTest();
  return result;
}

function startWriter(worker: Worker): WriterLifecycle {
  let readySettled = false;
  let finishedSettled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  let resolveFinished: (message: WriterResultMessage) => void = () => {};
  let rejectFinished: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finished = new Promise<WriterResultMessage>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const cleanup = () => {
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
  };
  const settleReady = (settle: () => void) => {
    if (!readySettled) {
      readySettled = true;
      settle();
    }
  };
  const settleFinished = (settle: () => void) => {
    if (!finishedSettled) {
      finishedSettled = true;
      cleanup();
      settle();
    }
  };
  const fail = (error: Error) => {
    settleReady(() => rejectReady(error));
    settleFinished(() => rejectFinished(error));
  };
  const onMessage = (message: WriterMessage) => {
    if (message.kind === "ready") {
      settleReady(resolveReady);
    } else if (message.kind === "result") {
      settleReady(resolveReady);
      settleFinished(() => resolveFinished(message));
    } else if (message.kind === "error") {
      fail(new Error(message.error));
    }
  };
  const onError = (error: Error) => {
    fail(error);
  };
  const onExit = (code: number) => {
    if (!finishedSettled) {
      fail(new Error(`writer exited before reporting result; exit code ${code}`));
    }
  };
  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.on("exit", onExit);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node Worker.postMessage has no targetOrigin.
  worker.postMessage({ kind: "start" });

  return {
    finished,
    ready,
    stop: () => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node Worker.postMessage has no targetOrigin.
      worker.postMessage({ kind: "stop" });
    },
  };
}

function verifyStressInvariants(databasePath: string, rowsPerBatch: number): void {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: unknown;
    };
    if (integrity.integrity_check !== "ok") {
      throw new Error(`restore integrity_check failed: ${String(integrity.integrity_check)}`);
    }
    const partial = db
      .prepare(
        `SELECT batch, COUNT(*) AS rows
           FROM snapshot_stress_entries
          GROUP BY batch
         HAVING rows <> ?
          LIMIT 1`,
      )
      .get(rowsPerBatch) as { batch?: unknown; rows?: unknown } | undefined;
    if (partial) {
      throw new Error(
        `partial transaction visible after restore: batch=${String(partial.batch)} rows=${String(partial.rows)}`,
      );
    }
  } finally {
    db.close();
  }
}

async function runStress(options: SnapshotStressOptions): Promise<SnapshotStressReport> {
  const config = PROFILES[options.profile];
  const stateDir =
    options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-stress-"));
  const repository = options.repository ?? path.join(stateDir, "snapshot-stress-repository");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const started = nowMs();
  const workers = new Set<Worker>();
  try {
    const target = resolveTargetDatabase(options, env);
    debug(`resolved target ${target.targetName} at ${target.path}`);
    setupStressTable(target.path);
    debug("stress table ready");
    const sourceWalBefore = walSize(target.path);
    const { createLocalSqliteSnapshotProvider } =
      await import("../src/snapshot/local-repository.js");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath: repository });
    const metrics: IterationMetric[] = [];
    const runScratchDir = path.join(stateDir, "snapshot-stress-runs", randomUUID());
    const syncedDir = path.join(runScratchDir, "synced");
    const restoredDir = path.join(runScratchDir, "restored");
    fs.mkdirSync(syncedDir, { recursive: true });
    fs.mkdirSync(restoredDir, { recursive: true });

    const worker = new Worker(WRITER_WORKER_SOURCE, {
      eval: true,
      workerData: {
        databasePath: target.path,
        rowsPerBatch: config.rowsPerBatch,
        writerPauseMs: config.writerPauseMs,
      } satisfies WriterData,
    });
    workers.add(worker);
    debug("worker constructed");
    const writer = startWriter(worker);
    let snapshotLoopComplete = false;
    const writerFinished = writer.finished.then((result) => {
      if (!snapshotLoopComplete) {
        throw new Error(
          `writer stopped before snapshot loop completed after ${result.batchesCommitted} batches`,
        );
      }
      return result;
    });
    await writer.ready;
    debug("worker ready");

    for (let iteration = 0; iteration < config.iterations; iteration += 1) {
      await Promise.race([
        (async () => {
          debug(`snapshot ${iteration} start`);
          const snapshotStarted = nowMs();
          const snapshot = await provider.create({
            id: target.id,
            kind: target.kind,
            path: target.path,
          });
          const snapshotMs = nowMs() - snapshotStarted;
          const copiedSnapshotPath = path.join(syncedDir, `snapshot-${iteration}`);
          fs.cpSync(snapshot.ref.path, copiedSnapshotPath, { recursive: true });
          const restorePath = path.join(restoredDir, `restore-${iteration}.sqlite`);
          const restoreStarted = nowMs();
          debug(`restore ${iteration} start`);
          await provider.restore({ path: copiedSnapshotPath }, restorePath);
          const restoreMs = nowMs() - restoreStarted;
          verifyStressInvariants(restorePath, config.rowsPerBatch);
          debug(`iteration ${iteration} verified`);
          metrics.push({
            restoreMs: Number(restoreMs.toFixed(3)),
            snapshotBytes: snapshot.manifest.artifact.sizeBytes,
            snapshotMs: Number(snapshotMs.toFixed(3)),
          });
        })(),
        writerFinished,
      ]);
    }

    const stoppedWorker = worker;
    snapshotLoopComplete = true;
    writer.stop();
    const writerResult = await writerFinished;
    await stoppedWorker.terminate();
    workers.delete(stoppedWorker);
    const summary = summarizeIterationMetrics(metrics);
    return {
      iterations: config.iterations,
      node: process.version,
      paths: {
        repository,
        sourceDatabase: target.path,
        stateDir,
      },
      profile: options.profile,
      restoresVerified: metrics.length,
      rowsPerBatch: config.rowsPerBatch,
      snapshotBytes: {
        max: summary.max,
        min: summary.min,
      },
      timingsMs: {
        restoreP50: summary.restoreP50,
        restoreP95: summary.restoreP95,
        snapshotP50: summary.snapshotP50,
        snapshotP95: summary.snapshotP95,
        total: Number((nowMs() - started).toFixed(3)),
      },
      target: target.targetName,
      walBytes: {
        after: walSize(target.path),
        before: sourceWalBefore,
      },
      writer: {
        batchesCommitted: writerResult.batchesCommitted,
        rowsCommitted: writerResult.rowsCommitted,
      },
    };
  } finally {
    for (const worker of workers) {
      if (worker.threadId !== -1) {
        await worker.terminate();
      }
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (!options.stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

function printProofLines(report: SnapshotStressReport): void {
  console.log(`SNAPSHOT_STRESS_PROFILE=${report.profile}`);
  console.log(`SNAPSHOT_STRESS_TARGET=${report.target}`);
  console.log(`SNAPSHOT_STRESS_ITERATIONS=${report.iterations}`);
  console.log(`SNAPSHOT_STRESS_RESTORES_VERIFIED=${report.restoresVerified}`);
  console.log(`SNAPSHOT_STRESS_WRITER_ROWS=${report.writer.rowsCommitted}`);
  console.log(`SNAPSHOT_STRESS_SNAPSHOT_P95_MS=${report.timingsMs.snapshotP95.toFixed(3)}`);
  console.log(`SNAPSHOT_STRESS_RESTORE_P95_MS=${report.timingsMs.restoreP95.toFixed(3)}`);
  console.log(`SNAPSHOT_STRESS_SNAPSHOT_BYTES_MAX=${report.snapshotBytes.max}`);
  console.log(`SNAPSHOT_STRESS_WAL_BYTES_AFTER=${report.walBytes.after}`);
}

export async function runSnapshotStressCli(argv = process.argv.slice(2)): Promise<void> {
  let options: SnapshotStressOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const report = await runStress(options);
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  printProofLines(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runSnapshotStressCli(process.argv.slice(2));
}
