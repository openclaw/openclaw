/**
 * Real-behavior measurement of the cron-tombstone sweep's responsiveness on a
 * large mixed session store while another process keeps committing writes.
 *
 * The review question this answers: the batched reference analysis added by this
 * PR is guarded by a connection-local validity token (`PRAGMA data_version` plus
 * TEMP-trigger generation). A concurrent writer invalidates that token, so the
 * memo stops answering. Does that make the sweep thrash, and does a sweep delay
 * the writes a Gateway turn performs?
 *
 * Real production code under test (nothing mocked):
 * - `sweepTombstonedCronRunRemnantsForStore` (src/config/sessions/cleanup-tombstones.ts)
 *   end to end: candidate scan, lifecycle admission, batched reference analysis,
 *   archive materialization, SQLite write transactions.
 * - `withBatchedSessionReferenceAnalysis` / `readReferencedSessionIds`
 *   (src/config/sessions/session-accessor.sqlite-lifecycle-state.ts) and
 *   `resolveBatchedReferencedSessionIds`
 *   (src/config/sessions/session-accessor.sqlite-reference-batch.ts).
 * - `replaceSessionEntry` / `loadSessionEntry` / `replaceTranscriptEventsSync`
 *   driven both from a separate OS process (so its commits reach the sweep's
 *   connection exactly the way a running Gateway's would) and from this process
 *   (so its writes contend for the process-local store writer queue the way an
 *   unrelated turn inside the Gateway that invoked `sessions.cleanup` would).
 * - The `openclaw.session.write` diagnostics channel in
 *   `session-accessor.sqlite-scope.ts`, which is the production telemetry for
 *   writer queue wait and writer execution time.
 *
 * Stubbed: nothing. No vitest, no mocks, no network. Only `OPENCLAW_STATE_DIR`
 * and the store layout are synthesized, under a temp directory.
 *
 * Scenarios:
 * 1. Quiet sweep over the mixed store: baseline wall clock, and the batched
 *    answer is checked against an unbatched read of the same store.
 * 2. Sweep with a concurrent writer process: sweep wall clock, and the writer's
 *    own per-operation latency before / during / after the sweep.
 * 3. Memo invalidation rate: how many reference questions the batch still serves
 *    while a writer commits, measured through the real resolver.
 * 4. Cost bound: the unbatched per-candidate reference read on the same store,
 *    which is what an invalidated batch falls back to.
 * 5. Sweep beside an unrelated writer in the SAME process. The store writer
 *    queue is process-local and FIFO, so a separate writer process cannot
 *    observe it at all; this scenario puts the writer on this process's event
 *    loop and reads the real `openclaw.session.write` diagnostics channel to
 *    measure how long each writer section holds the lane and how long unrelated
 *    writes wait for it.
 *
 * Scenario 1 also counts the transcript-archive worker threads the sweep spawns,
 * because attributing the per-candidate cost is what makes the reference-analysis
 * share of it interpretable.
 *
 * Tunables (env): PROOF_LIVE_ROWS, PROOF_CANDIDATES, PROOF_WRITER_INTERVAL_MS,
 * PROOF_BASELINE_MS, PROOF_TAIL_MS. Defaults take about eight minutes.
 *
 * Run: pnpm tsx scripts/proof-117074-concurrent-write-latency.ts
 */
import asyncHooks from "node:async_hooks";
import { fork } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { sweepTombstonedCronRunRemnantsForStore } from "../src/config/sessions/cleanup-tombstones.js";
import { loadSessionEntry, replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import { deleteSessionEntryRows } from "../src/config/sessions/session-accessor.sqlite-entry-store.js";
import {
  readReferencedSessionIds,
  withBatchedSessionReferenceAnalysis,
} from "../src/config/sessions/session-accessor.sqlite-lifecycle-state.js";
import { resolveBatchedReferencedSessionIds } from "../src/config/sessions/session-accessor.sqlite-reference-batch.js";
import { getSessionKysely } from "../src/config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "../src/config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../src/config/sessions/session-sqlite-target.js";
import { executeSqliteQuerySync } from "../src/infra/kysely-sync.js";
import { readSqliteDataVersion } from "../src/infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../src/state/openclaw-state-db-contract.js";
import { cleanupSessionStateForTest } from "../src/test-utils/session-state-cleanup.js";

const HOUR_MS = 3_600_000;
const WRITER_ROLE_FLAG = "--writer";
const LIVE_ROWS = Number(process.env.PROOF_LIVE_ROWS ?? 3_000);
const CANDIDATE_COUNT = Number(process.env.PROOF_CANDIDATES ?? 96);
const WRITER_INTERVAL_MS = Number(process.env.PROOF_WRITER_INTERVAL_MS ?? 5);
/** Backstop for joining the writer process; its own drain is far shorter. */
const WRITER_JOIN_TIMEOUT_MS = 30_000;
const BASELINE_MS = Number(process.env.PROOF_BASELINE_MS ?? 6_000);
const TAIL_MS = Number(process.env.PROOF_TAIL_MS ?? 2_000);
/** Reference batch size used by the sweep; mirrored here only to report batch counts. */
const SWEEP_BATCH_SIZE = 32;

type WriterSample = {
  /** Wall-clock ms when the operation completed, used to partition by sweep phase. */
  at: number;
  durationMs: number;
};

type WriterReport = {
  samples: WriterSample[];
  errors: string[];
};

/** Production diagnostics channel published by every exclusive store write. */
const SESSION_WRITE_CHANNEL = "openclaw.session.write";

type StoreWriteRecord = {
  /** Wall-clock ms when the write completed, used to partition by sweep phase. */
  at: number;
  operation: string;
  /** How long this write waited for the process-local writer lane. */
  queueWaitMs: number;
  /** How long this write held the lane, which is what blocks everyone else. */
  writerExecutionMs: number;
};

let assertions = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  assertions += 1;
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    failures.push(`${label}: expected ${expectedText}, got ${actualText}`);
    console.log(`  FAIL ${label}: expected ${expectedText}, got ${actualText}`);
    return;
  }
  console.log(`  ok   ${label} = ${actualText}`);
}

function checkAtMost(label: string, actual: number, ceiling: number): void {
  assertions += 1;
  if (!(actual <= ceiling)) {
    failures.push(`${label}: expected <= ${ceiling}, got ${actual}`);
    console.log(`  FAIL ${label}: expected <= ${ceiling}, got ${actual}`);
    return;
  }
  console.log(`  ok   ${label} = ${actual} (<= ${ceiling})`);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function describeLatency(label: string, values: readonly number[], windowMs: number): void {
  if (values.length === 0) {
    console.log(`    ${label}: no samples`);
    return;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  console.log(
    `    ${label}: n=${values.length} rate=${round((values.length / windowMs) * 1000)}/s ` +
      `mean=${round(total / values.length)}ms p50=${round(percentile(values, 0.5))}ms ` +
      `p95=${round(percentile(values, 0.95))}ms p99=${round(percentile(values, 0.99))}ms ` +
      `max=${round(Math.max(...values))}ms`,
  );
}

/** Candidate generation ids seeded by `seedMixedStore`, in seeding order. */
function candidateGenerationIds(count: number): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(`cron-generation-${index}`);
  }
  return ids;
}

function openStore(storePath: string, agentId: string) {
  const resolved = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  if (!resolved.path) {
    throw new Error(`no sqlite path resolved for ${storePath}`);
  }
  return openOpenClawAgentDatabase({ agentId: resolved.agentId ?? agentId, path: resolved.path });
}

/**
 * Seeds one canonical expired cron retained-history placeholder: a real entry
 * plus transcript written through the accessor, then the readable entry rows are
 * deleted so only the intentionally empty placeholder remains.
 */
async function seedExpiredCronPlaceholder(params: {
  storePath: string;
  ownerAgentId: string;
  sessionKey: string;
  sessionId: string;
  ageMs: number;
}): Promise<void> {
  await replaceSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    { sessionId: params.sessionId, updatedAt: Date.now() },
  );
  replaceTranscriptEventsSync(
    { sessionKey: params.sessionKey, sessionId: params.sessionId, storePath: params.storePath },
    [{ type: "session", id: params.sessionId, content: "cron run transcript" }],
  );
  const database = openStore(params.storePath, params.ownerAgentId);
  deleteSessionEntryRows(database, params.sessionKey);
  const updatedAt = Date.now() - params.ageMs;
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_windows")
      .set({ updated_at: updatedAt })
      .where("session_key", "=", params.sessionKey),
  );
  // Separate statements on purpose: one combined `.set({ updated_at, entry_valid })`
  // does not persist `entry_valid`, and the canonical placeholder predicate
  // requires `entry_valid === -1`.
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_nodes")
      .set({ updated_at: updatedAt })
      .where("session_key", "=", params.sessionKey),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_nodes")
      .set({ entry_valid: -1 })
      .where("session_key", "=", params.sessionKey),
  );
}

/**
 * Builds a mixed store: live sessions, a share of them carrying the optional
 * reference fields the narrowing predicate must retain by presence, plus expired
 * cron placeholders for the sweep to reclaim.
 */
async function seedMixedStore(storePath: string): Promise<{ candidateKeys: string[] }> {
  for (let index = 0; index < LIVE_ROWS; index += 1) {
    const sessionId = `live-generation-${index}`;
    const carriesReferences = index % 7 === 0;
    await replaceSessionEntry(
      { sessionKey: `agent:main:live:session-${index}`, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
        ...(carriesReferences
          ? {
              previousSessionId: `live-generation-prev-${index}`,
              usageFamilySessionIds: [`live-family-${index}-a`, `live-family-${index}-b`],
            }
          : {}),
      },
    );
  }
  const candidateKeys: string[] = [];
  for (let index = 0; index < CANDIDATE_COUNT; index += 1) {
    const sessionKey = `agent:main:cron:job-${index}:run:run-${index}`;
    candidateKeys.push(sessionKey);
    await seedExpiredCronPlaceholder({
      storePath,
      ownerAgentId: "main",
      sessionKey,
      sessionId: `cron-generation-${index}`,
      ageMs: 72 * HOUR_MS,
    });
  }
  return { candidateKeys };
}

function countNodeRows(storePath: string): number {
  const database = openStore(storePath, "main");
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(database.db, db.selectFrom("session_nodes").select("session_key"))
    .rows.length;
}

function countRemainingCandidates(storePath: string, candidateKeys: readonly string[]): number {
  const database = openStore(storePath, "main");
  const db = getSessionKysely(database.db);
  const present = new Set(
    executeSqliteQuerySync(
      database.db,
      db.selectFrom("session_nodes").select("session_key"),
    ).rows.map((row) => row.session_key),
  );
  return candidateKeys.filter((key) => present.has(key)).length;
}

async function runSweep(
  storePath: string,
  dryRun = false,
): Promise<{ durationMs: number; candidates: number; removedNodes: number }> {
  const startedAt = performance.now();
  const result = await sweepTombstonedCronRunRemnantsForStore({
    target: { agentId: "main", storePath },
    retentionMs: 24 * HOUR_MS,
    dryRun,
  });
  return {
    candidates: result?.candidates ?? -1,
    durationMs: performance.now() - startedAt,
    removedNodes: result?.removedNodes ?? -1,
  };
}

/**
 * Counts worker threads created while `run` executes and how long they stayed
 * alive, which attributes the sweep's wall clock between off-thread transcript
 * archival and everything the main thread does itself.
 */
async function withWorkerAttribution<T>(
  run: () => Promise<T>,
): Promise<{ result: T; workers: number; workerMs: number }> {
  const startedAtById = new Map<number, number>();
  let workers = 0;
  let workerMs = 0;
  const hook = asyncHooks.createHook({
    destroy(id) {
      const startedAt = startedAtById.get(id);
      if (startedAt !== undefined) {
        startedAtById.delete(id);
        workerMs += performance.now() - startedAt;
      }
    },
    init(id, type) {
      if (type === "WORKER") {
        workers += 1;
        startedAtById.set(id, performance.now());
      }
    },
  });
  hook.enable();
  try {
    const result = await run();
    return { result, workerMs, workers };
  } finally {
    hook.disable();
  }
}

/** Waits until another connection's commit is visible to this one. */
async function waitForForeignCommit(database: { db: Parameters<typeof readSqliteDataVersion>[0] }) {
  const initial = readSqliteDataVersion(database.db);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (readSqliteDataVersion(database.db) !== initial) {
      return;
    }
    await delay(50);
  }
  throw new Error("no concurrent commit became visible within 30s");
}

function makeStateDir(): string {
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "proof-117074-concurrency-")),
  );
}

const fixtureRoots: string[] = [];

function makeTrackedStateDir(): string {
  const stateDir = makeStateDir();
  fixtureRoots.push(stateDir);
  return stateDir;
}

/**
 * Joins the asynchronous database owners for one fixture root.
 *
 * `closeOpenClawAgentDatabasesForTest` only *starts* resource closure; the
 * reclamation workers a sweep spawned still have to release their durable
 * leases, and that release reopens the shared state database.
 * `cleanupSessionStateForTest` is the existing awaited owner: it drains the
 * store writer queues and file locks, then closes the agent handles and the
 * shared state database for this root.
 */
async function releaseSessionState(stateDir: string): Promise<void> {
  await cleanupSessionStateForTest({ stateDir });
}

/**
 * Joins every owner this process holds, then removes the fixture roots.
 *
 * Called once, after the last scenario, because the drain is process-wide:
 * running it between scenarios would leave each later scenario measuring a
 * cold store instead of the steady state this harness reports.
 */
async function releaseFixtureRoots(): Promise<void> {
  for (const stateDir of fixtureRoots) {
    await releaseSessionState(stateDir);
  }
  closeOpenClawAgentDatabasesForTest();
  for (const stateDir of fixtureRoots) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  fixtureRoots.length = 0;
}

/** Concurrent writer process: the Gateway-shaped load this sweep runs beside. */
async function runWriterRole(): Promise<void> {
  const storePath = process.env.PROOF_STORE_PATH;
  const controlDir = process.env.PROOF_CONTROL_DIR;
  if (!storePath || !controlDir) {
    throw new Error("writer role requires PROOF_STORE_PATH and PROOF_CONTROL_DIR");
  }
  const samples: WriterSample[] = [];
  const errors: string[] = [];
  let index = 0;
  // One warm operation before announcing readiness: the first write pays database
  // open and schema validation, which is startup, not steady-state latency.
  await replaceSessionEntry(
    { sessionKey: "agent:main:live:writer-warmup", storePath },
    { sessionId: "writer-warmup", updatedAt: Date.now() },
  );
  fs.writeFileSync(path.join(controlDir, "writer-ready"), "1");
  while (!fs.existsSync(path.join(controlDir, "writer-stop"))) {
    const sessionKey = `agent:main:live:writer-${index % 64}`;
    const sessionId = `writer-generation-${index}`;
    const startedAt = performance.now();
    try {
      // One Gateway-turn-shaped unit of session work: persist the entry, append
      // its transcript, read the entry back.
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
      replaceTranscriptEventsSync({ sessionKey, sessionId, storePath }, [
        { type: "session", id: sessionId, content: `writer turn ${index}` },
      ]);
      loadSessionEntry({ sessionKey, storePath });
      samples.push({ at: Date.now(), durationMs: performance.now() - startedAt });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    index += 1;
    await delay(WRITER_INTERVAL_MS);
  }
  // This process owns real leases on the parent's fixture root. Release them
  // before publishing the report: the parent treats the report's appearance as
  // the signal to join this exit and remove the root, so a drain that throws
  // must leave no report behind rather than a report that outran its own
  // shutdown.
  await releaseSessionState(process.env.OPENCLAW_STATE_DIR ?? path.dirname(storePath));
  const report: WriterReport = { errors, samples };
  fs.writeFileSync(path.join(controlDir, "writer-report.json.part"), JSON.stringify(report));
  fs.renameSync(
    path.join(controlDir, "writer-report.json.part"),
    path.join(controlDir, "writer-report.json"),
  );
  // Every owner has drained, so the loop can run dry instead of being cut short.
  process.exitCode = 0;
}

type WriterHandle = {
  stop: () => Promise<WriterReport>;
};

async function waitForFile(file: string, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`${label} did not appear within ${timeoutMs}ms`);
}

/**
 * Starts the concurrent writer as a separate OS process.
 *
 * Coordination is through files rather than IPC: a long-lived parent that has
 * already spawned many worker threads proved able to lose an IPC handshake, and
 * a lost handshake would silently turn a contention measurement into a quiet one.
 */
async function startWriter(stateDir: string, storePath: string): Promise<WriterHandle> {
  const controlDir = fs.mkdtempSync(path.join(stateDir, "writer-control-"));
  const child = fork(fileURLToPath(import.meta.url), [WRITER_ROLE_FLAG], {
    detached: false,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      PROOF_CONTROL_DIR: controlDir,
      PROOF_STORE_PATH: storePath,
    },
    execArgv: ["--import", path.resolve("scripts/tsx.mjs")],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  // Registered at fork time so the exit outcome can never be missed between the
  // report landing and the join below. The outcome is kept, not discarded: a
  // nonzero exit or a signal means the child's own shutdown failed, and a proof
  // may not report success on a writer that did not shut down.
  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  let childOutput = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    childOutput += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    childOutput += chunk.toString("utf8");
  });
  try {
    await waitForFile(path.join(controlDir, "writer-ready"), "writer readiness", 120_000);
  } catch (error) {
    child.kill();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; writer output: ${childOutput.slice(-2000)}`,
      { cause: error },
    );
  }
  console.log(`    writer process ready (pid ${child.pid ?? "unknown"})`);
  return {
    stop: async () => {
      fs.writeFileSync(path.join(controlDir, "writer-stop"), "1");
      const reportPath = path.join(controlDir, "writer-report.json");
      await waitForFile(reportPath, "writer report", 60_000);
      // SAFETY: the child writes this file only after its own drain succeeds, and writes it atomically through a rename, so a readable file is a complete report.
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as WriterReport;
      // Join the writer process before the caller removes the fixture root: it
      // releases its own database leases on the way out. The kill stays only as
      // a bounded backstop so a wedged child cannot hang the harness, and
      // firing it is itself a failure rather than a quiet fallback.
      let backstopFired = false;
      const killBackstop = setTimeout(() => {
        backstopFired = true;
        child.kill();
      }, WRITER_JOIN_TIMEOUT_MS);
      killBackstop.unref();
      let outcome: { code: number | null; signal: NodeJS.Signals | null };
      try {
        outcome = await childExit;
      } finally {
        clearTimeout(killBackstop);
      }
      if (backstopFired || outcome.code !== 0 || outcome.signal !== null) {
        throw new Error(
          `writer process did not shut down cleanly: code=${outcome.code} signal=${outcome.signal}` +
            `${backstopFired ? " (join backstop fired)" : ""}; writer output: ${childOutput.slice(-2000)}`,
        );
      }
      return report;
    },
  };
}

async function scenarioQuietSweep(): Promise<{ durationMs: number }> {
  console.log("\n[1] Quiet sweep over the mixed store (no concurrent writer)");
  const stateDir = makeTrackedStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "sessions.sqlite");
  const seedStartedAt = performance.now();
  const { candidateKeys } = await seedMixedStore(storePath);
  console.log(`    seeded in ${round(performance.now() - seedStartedAt)}ms`);
  check("node rows seeded", countNodeRows(storePath), LIVE_ROWS + CANDIDATE_COUNT);
  check(
    "candidates present before sweep",
    countRemainingCandidates(storePath, candidateKeys),
    CANDIDATE_COUNT,
  );

  // The batched answer must equal an unbatched read of the same quiet store.
  const database = openStore(storePath, "main");
  const probeIds = candidateGenerationIds(8);
  // `null` records "the memo declined to answer", which must not read as an empty
  // answer: a resolver that never serves would otherwise match an empty read.
  const batchedAnswers: Array<string[] | null> = [];
  await withBatchedSessionReferenceAnalysis(database, probeIds, async () => {
    for (const sessionId of probeIds) {
      const excluded = new Set([`agent:main:cron:job-x:run:run-x`]);
      const served = resolveBatchedReferencedSessionIds(database.db, database.path, excluded, [
        sessionId,
      ]);
      batchedAnswers.push(served ? [...served].toSorted() : null);
    }
    await Promise.resolve();
  });
  const unbatchedAnswers = probeIds.map((sessionId) =>
    [
      ...readReferencedSessionIds(database, new Set([`agent:main:cron:job-x:run:run-x`]), [
        sessionId,
      ]),
    ].toSorted(),
  );
  check(
    "batched answers equal unbatched answers on a quiet store",
    batchedAnswers,
    unbatchedAnswers,
  );

  // A dry run performs the candidate scan and stops, which separates "find the
  // work on a large store" from "reclaim each candidate".
  const scan = await runSweep(storePath, true);
  check("dry run found every candidate", scan.candidates, CANDIDATE_COUNT);
  check("dry run removed nothing", scan.removedNodes, 0);

  const attributed = await withWorkerAttribution(async () => await runSweep(storePath));
  const sweep = attributed.result;
  check("quiet sweep removed every candidate", sweep.removedNodes, CANDIDATE_COUNT);
  check("no candidate rows remain", countRemainingCandidates(storePath, candidateKeys), 0);
  console.log(
    `    candidate scan over the whole store: ${round(scan.durationMs)}ms\n` +
      `    quiet sweep: ${round(sweep.durationMs)}ms total, ` +
      `${round(sweep.durationMs / CANDIDATE_COUNT)}ms per candidate, ` +
      `${Math.ceil(CANDIDATE_COUNT / SWEEP_BATCH_SIZE)} reference batches\n` +
      `    transcript-archive worker threads: ${attributed.workers} spawned, ` +
      `${round(attributed.workerMs)}ms of worker lifetime ` +
      `(${round((100 * attributed.workerMs) / sweep.durationMs)}% of the sweep, off the main thread)`,
  );
  return { durationMs: sweep.durationMs };
}

async function scenarioConcurrentWriter(quietDurationMs: number): Promise<void> {
  console.log("\n[2] Sweep with a separate writer process committing throughout");
  const stateDir = makeTrackedStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "sessions.sqlite");
  const { candidateKeys } = await seedMixedStore(storePath);
  check("node rows seeded", countNodeRows(storePath), LIVE_ROWS + CANDIDATE_COUNT);

  const writer = await startWriter(stateDir, storePath);
  await delay(BASELINE_MS);
  const sweepStartedAt = Date.now();
  const sweep = await runSweep(storePath);
  const sweepEndedAt = Date.now();
  await delay(TAIL_MS);
  const report = await writer.stop();

  check("writer recorded no errors", report.errors.slice(0, 3), []);
  check(
    "sweep under concurrent writes removed every candidate",
    sweep.removedNodes,
    CANDIDATE_COUNT,
  );
  check("no candidate rows remain", countRemainingCandidates(storePath, candidateKeys), 0);

  const before = report.samples.filter((sample) => sample.at < sweepStartedAt);
  const during = report.samples.filter(
    (sample) => sample.at >= sweepStartedAt && sample.at <= sweepEndedAt,
  );
  const after = report.samples.filter((sample) => sample.at > sweepEndedAt);
  console.log("    Gateway-shaped session work in the writer process:");
  describeLatency(
    "before sweep",
    before.map((sample) => sample.durationMs),
    BASELINE_MS,
  );
  describeLatency(
    "during sweep",
    during.map((sample) => sample.durationMs),
    sweep.durationMs,
  );
  describeLatency(
    "after sweep ",
    after.map((sample) => sample.durationMs),
    TAIL_MS,
  );
  console.log(
    `    sweep: ${round(sweep.durationMs)}ms with a writer vs ${round(quietDurationMs)}ms quiet ` +
      `(${round(sweep.durationMs / quietDurationMs)}x), ` +
      `${round(sweep.durationMs / CANDIDATE_COUNT)}ms per candidate`,
  );

  const duringMax = during.length > 0 ? Math.max(...during.map((sample) => sample.durationMs)) : 0;
  checkAtMost(
    "worst concurrent Gateway operation stays inside the SQLite busy timeout (ms)",
    round(duringMax),
    OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  );
  check("writer kept making progress during the sweep", during.length > 0, true);
}

async function scenarioInvalidationRate(): Promise<void> {
  console.log("\n[3] Memo invalidation rate while a writer commits");
  const stateDir = makeTrackedStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "sessions.sqlite");
  await seedMixedStore(storePath);
  const database = openStore(storePath, "main");
  const probeIds = candidateGenerationIds(SWEEP_BATCH_SIZE);
  const excluded = new Set(["agent:main:cron:job-x:run:run-x"]);

  // One batch of the sweep: 32 candidates, two reference questions each, with the
  // per-candidate reclaim work between them.
  const measureBatch = async (): Promise<{ served: number; fallback: number }> => {
    let served = 0;
    let fallback = 0;
    await withBatchedSessionReferenceAnalysis(database, probeIds, async () => {
      for (const sessionId of probeIds) {
        for (let question = 0; question < 2; question += 1) {
          if (
            resolveBatchedReferencedSessionIds(database.db, database.path, excluded, [sessionId])
          ) {
            served += 1;
          } else {
            fallback += 1;
          }
        }
        await delay(2);
      }
    });
    return { fallback, served };
  };

  const quiet = await measureBatch();
  check("quiet store: every reference question is served from the memo", quiet.fallback, 0);

  const writer = await startWriter(stateDir, storePath);
  await waitForForeignCommit(database);
  const batches = Math.ceil(CANDIDATE_COUNT / SWEEP_BATCH_SIZE);
  let servedTotal = 0;
  let fallbackTotal = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const measured = await measureBatch();
    servedTotal += measured.served;
    fallbackTotal += measured.fallback;
    console.log(
      `    batch ${batch + 1}/${batches}: served ${measured.served}, fell back ${measured.fallback}`,
    );
  }
  await writer.stop();
  console.log(
    `    with a writer: ${servedTotal}/${servedTotal + fallbackTotal} questions served, ` +
      `${fallbackTotal} fell back to a fresh read`,
  );
  console.log(
    "    note: invalidation deletes the batch for the rest of its run, so a batch is primed at most " +
      "once and can never re-prime in a loop.",
  );
}

/**
 * Records the real writer-queue telemetry every exclusive store write already
 * publishes. Subscribing is what turns publication on, so this observes the
 * production timing rather than re-deriving it.
 */
function startStoreWriterTelemetry(): { stop: () => StoreWriteRecord[] } {
  const records: StoreWriteRecord[] = [];
  const onWrite = (message: unknown) => {
    const write = message as Partial<Record<keyof StoreWriteRecord, unknown>>;
    if (
      typeof write.operation !== "string" ||
      typeof write.queueWaitMs !== "number" ||
      typeof write.writerExecutionMs !== "number"
    ) {
      return;
    }
    records.push({
      at: Date.now(),
      operation: write.operation,
      queueWaitMs: write.queueWaitMs,
      writerExecutionMs: write.writerExecutionMs,
    });
  };
  subscribe(SESSION_WRITE_CHANNEL, onWrite);
  return {
    stop: () => {
      unsubscribe(SESSION_WRITE_CHANNEL, onWrite);
      return records;
    },
  };
}

type InProcessWriterHandle = { stop: () => Promise<WriterReport> };

/**
 * The same Gateway-turn-shaped session work the writer process performs, run on
 * this process's event loop so it queues on the same store writer lane the
 * sweep uses. This is the contention a separate process structurally cannot see.
 */
async function startInProcessWriter(storePath: string): Promise<InProcessWriterHandle> {
  const samples: WriterSample[] = [];
  const errors: string[] = [];
  const control = { running: true };
  // One warm operation before the loop: the first write pays database open and
  // schema validation, which is startup, not steady-state latency.
  await replaceSessionEntry(
    { sessionKey: "agent:main:live:inprocess-warmup", storePath },
    { sessionId: "inprocess-warmup", updatedAt: Date.now() },
  );
  const loop = (async () => {
    let index = 0;
    while (control.running) {
      const sessionKey = `agent:main:live:inprocess-${index % 64}`;
      const sessionId = `inprocess-generation-${index}`;
      const startedAt = performance.now();
      try {
        await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
        replaceTranscriptEventsSync({ sessionKey, sessionId, storePath }, [
          { type: "session", id: sessionId, content: `in-process turn ${index}` },
        ]);
        loadSessionEntry({ sessionKey, storePath });
        samples.push({ at: Date.now(), durationMs: performance.now() - startedAt });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      index += 1;
      await delay(WRITER_INTERVAL_MS);
    }
  })();
  return {
    stop: async () => {
      control.running = false;
      await loop;
      return { errors, samples };
    },
  };
}

function maxOf(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : Math.max(...values);
}

async function scenarioSameProcessWriter(): Promise<void> {
  console.log("\n[5] Sweep beside an unrelated writer in the same process");
  const stateDir = makeTrackedStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "sessions.sqlite");
  const { candidateKeys } = await seedMixedStore(storePath);
  check("node rows seeded", countNodeRows(storePath), LIVE_ROWS + CANDIDATE_COUNT);

  const writer = await startInProcessWriter(storePath);
  const telemetry = startStoreWriterTelemetry();
  await delay(BASELINE_MS);
  const sweepStartedAt = Date.now();
  const sweep = await runSweep(storePath);
  const sweepEndedAt = Date.now();
  await delay(TAIL_MS);
  const report = await writer.stop();
  const writes = telemetry.stop();

  check("in-process writer recorded no errors", report.errors.slice(0, 3), []);
  check(
    "sweep beside a same-process writer removed every candidate",
    sweep.removedNodes,
    CANDIDATE_COUNT,
  );
  check("no candidate rows remain", countRemainingCandidates(storePath, candidateKeys), 0);

  const inWindow = (at: number) => at >= sweepStartedAt && at <= sweepEndedAt;
  console.log("    Gateway-shaped session work on the sweep's own event loop:");
  describeLatency(
    "before sweep",
    report.samples
      .filter((sample) => sample.at < sweepStartedAt)
      .map((sample) => sample.durationMs),
    BASELINE_MS,
  );
  const during = report.samples.filter((sample) => inWindow(sample.at));
  describeLatency(
    "during sweep",
    during.map((sample) => sample.durationMs),
    sweep.durationMs,
  );
  describeLatency(
    "after sweep ",
    report.samples.filter((sample) => sample.at > sweepEndedAt).map((sample) => sample.durationMs),
    TAIL_MS,
  );

  const perCandidateMs = sweep.durationMs / CANDIDATE_COUNT;
  const duringWrites = writes.filter((write) => inWindow(write.at));
  const sweepSections = duringWrites.filter((write) =>
    write.operation.startsWith("session.maintenance.tombstone"),
  );
  const unrelatedWrites = duringWrites.filter((write) => write.operation === "session-entry.patch");
  for (const operation of [...new Set(sweepSections.map((write) => write.operation))].toSorted()) {
    const held = sweepSections
      .filter((write) => write.operation === operation)
      .map((write) => write.writerExecutionMs);
    console.log(
      `    ${operation}: n=${held.length} mean=${round(held.reduce((sum, value) => sum + value, 0) / held.length)}ms ` +
        `p95=${round(percentile(held, 0.95))}ms max=${round(maxOf(held))}ms held`,
    );
  }
  console.log(
    `    unrelated same-process writes: n=${unrelatedWrites.length} ` +
      `p95 queue wait=${round(
        percentile(
          unrelatedWrites.map((write) => write.queueWaitMs),
          0.95,
        ),
      )}ms ` +
      `max queue wait=${round(maxOf(unrelatedWrites.map((write) => write.queueWaitMs)))}ms\n` +
      `    sweep: ${round(sweep.durationMs)}ms, ${round(perCandidateMs)}ms per candidate`,
  );

  // Each reclaim must take the writer lane twice — once to decide, once to
  // delete — with archive encoding between them. One section per candidate is
  // the shape that holds the lane across encoding.
  check(
    "two store-writer sections per reclaimed candidate",
    sweepSections.length,
    2 * CANDIDATE_COUNT,
  );
  check(
    "unrelated same-process writes completed during the sweep",
    unrelatedWrites.length > 0,
    true,
  );

  // Self-calibrating ceiling: a section that spanned archive encoding would last
  // about as long as a whole candidate, because encoding is ~99.5% of that cost.
  // A quarter of the per-candidate wall clock separates the two shapes on any
  // host, since both sides scale with the host.
  const holdCeilingMs = round(perCandidateMs / 4);
  checkAtMost(
    "longest store-writer section held by the sweep (ms)",
    round(maxOf(sweepSections.map((write) => write.writerExecutionMs))),
    holdCeilingMs,
  );
  checkAtMost(
    "longest wait an unrelated same-process write spent on the writer lane (ms)",
    round(maxOf(unrelatedWrites.map((write) => write.queueWaitMs))),
    holdCeilingMs,
  );
  checkAtMost(
    "worst unrelated same-process operation during the sweep (ms)",
    round(maxOf(during.map((sample) => sample.durationMs))),
    OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  );
}

async function scenarioUnbatchedCostBound(): Promise<void> {
  console.log("\n[4] Cost of the unbatched read an invalidated batch falls back to");
  const stateDir = makeTrackedStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "sessions.sqlite");
  await seedMixedStore(storePath);
  const database = openStore(storePath, "main");
  const probeIds = candidateGenerationIds(SWEEP_BATCH_SIZE);
  const excluded = new Set(["agent:main:cron:job-x:run:run-x"]);

  const unbatchedStartedAt = performance.now();
  for (const sessionId of probeIds) {
    readReferencedSessionIds(database, excluded, [sessionId]);
  }
  const unbatchedMs = performance.now() - unbatchedStartedAt;

  const batchedStartedAt = performance.now();
  await withBatchedSessionReferenceAnalysis(database, probeIds, async () => {
    for (const sessionId of probeIds) {
      readReferencedSessionIds(database, excluded, [sessionId]);
    }
    await Promise.resolve();
  });
  const batchedMs = performance.now() - batchedStartedAt;

  console.log(
    `    ${SWEEP_BATCH_SIZE} reference questions: unbatched ${round(unbatchedMs)}ms ` +
      `(${round(unbatchedMs / SWEEP_BATCH_SIZE)}ms each) vs batched ${round(batchedMs)}ms ` +
      `(${round(batchedMs / SWEEP_BATCH_SIZE)}ms each)`,
  );
  console.log(
    "    a fully invalidated batch therefore costs the unbatched total plus one priming pass, " +
      "which is the pre-batch cost of this sweep, not a multiple of it.",
  );
}

async function main(): Promise<void> {
  console.log(
    `store: ${LIVE_ROWS} live rows + ${CANDIDATE_COUNT} expired cron placeholders; ` +
      `writer interval ${WRITER_INTERVAL_MS}ms`,
  );
  const quiet = await scenarioQuietSweep();
  await scenarioConcurrentWriter(quiet.durationMs);
  await scenarioInvalidationRate();
  await scenarioUnbatchedCostBound();
  await scenarioSameProcessWriter();
  // Teardown belongs here, not per scenario: joining the owners is what lets
  // every fixture root be removed without a lease chasing a deleted file.
  await releaseFixtureRoots();
  console.log(`\nassertions: ${assertions}, failures: ${failures.length}`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`FAILED: ${failure}`);
    }
    throw new Error(`${failures.length} runtime assertion(s) failed`);
  }
  console.log("All runtime assertions passed.");
}

if (process.argv.includes(WRITER_ROLE_FLAG)) {
  await runWriterRole();
} else {
  await main();
}
