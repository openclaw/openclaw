/**
 * Synthetic archive-worker retention on Node 26.12, with GC outside timed reads.
 * Run from the repository root on the approved benchmark host:
 * Prepare once on the host's preparation CPUs, then measure on its quiet CPUs:
 *   node --import ./scripts/tsx.mjs scripts/perf/archive-worker-retention-measure.ts \
 *     --prepare-only --output /absolute/new-fixture
 *   node --import ./scripts/tsx.mjs scripts/perf/archive-worker-retention-measure.ts \
 *     --fixture /absolute/new-fixture --output /absolute/new-results \
 *     --samples 1000 [--snapshot] [--owner-dir /absolute/base]
 * Exactly one of --prepare-only or --fixture is required. Measurement reuses the
 * prepared database without regenerating it. Output directories must not exist.
 * --owner-dir substitutes matching source files
 * through worker-retained-heap-preload; baseline and candidate use the same probe.
 * Alternate five fresh baseline/candidate processes. Snapshots are optional because
 * they distort subsequent timing; use separate snapshot and measurement passes.
 * Concurrent pairs can synchronize warm final/page reads with --start-at and
 * --page-start-at (future epoch milliseconds, with enough time for each phase).
 * Repeat separately with OPENCLAW_BENCH_TRACE_GC=1 for isolate-attributed promotion;
 * exclude those traced timings and forced identification collections from gates.
 * --page-first also records cold paging before final-result reads warm shared imports.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type {
  SqliteArchiveOperation,
  SqliteArchiveSessionResponse,
  TranscriptArchiveReadPlan,
} from "../../src/config/sessions/session-accessor.sqlite-archive-types.js";
import type { DB } from "../../src/state/openclaw-agent-db.generated.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "prepare-only": { type: "boolean", default: false },
    fixture: { type: "string" },
    "page-first": { type: "boolean", default: false },
    samples: { type: "string", default: "1000" },
    "start-at": { type: "string" },
    "page-start-at": { type: "string" },
    snapshot: { type: "boolean", default: false },
    "owner-dir": { type: "string" },
  },
});
assert(values.output, "--output must name a new fixture or result directory");
assert(
  values["prepare-only"] !== Boolean(values.fixture),
  "Choose exactly one of --prepare-only or --fixture",
);
const fixture = values.fixture ? path.resolve(values.fixture) : undefined;
if (fixture) {
  assert(
    fs.existsSync(path.join(fixture, "state", "archive.sqlite")),
    "Prepared fixture is missing",
  );
}
const root = path.resolve(values.output);
assert(!fs.existsSync(root), "Refusing to overwrite an existing output directory");
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0, "--samples must be a positive integer");
const startAt = values["start-at"] === undefined ? undefined : Number(values["start-at"]);
assert(startAt === undefined || (Number.isSafeInteger(startAt) && startAt > 0));
const pageStartAt =
  values["page-start-at"] === undefined ? undefined : Number(values["page-start-at"]);
assert(pageStartAt === undefined || (Number.isSafeInteger(pageStartAt) && pageStartAt > 0));
const output = path.join(root, "workers");
const env = {
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: path.join(fixture ?? root, "state"),
  OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
fs.mkdirSync(root);
for (const directory of [output, env.HOME, env.TMPDIR]) {
  fs.mkdirSync(directory);
}
if (!fixture) {
  fs.mkdirSync(env.OPENCLAW_STATE_DIR);
}
fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ plugins: { enabled: false } }));
Object.assign(process.env, env);
const databasePath = path.join(env.OPENCLAW_STATE_DIR, "archive.sqlite");
const options = { agentId: "main", env, path: databasePath };
const sessions = 64;
const messagesPerSession = 100;

async function prepareFixture() {
  const agentDb = await import("../../src/state/openclaw-agent-db.js");
  const { executeSqliteQuerySync, getNodeSqliteKysely } =
    await import("../../src/infra/kysely-sync.js");
  try {
    const database = agentDb.openOpenClawAgentDatabase(options);
    agentDb.runOpenClawAgentWriteTransaction(() => {
      const query = getNodeSqliteKysely<DB>(database.db);
      for (let index = 0; index < sessions; index++) {
        const sessionId = `synthetic-session-${index}`;
        const events: unknown[] = [
          { type: "session", id: sessionId, timestamp: "2026-01-01T00:00:00.000Z" },
        ];
        for (let item = 0; item < messagesPerSession; item++) {
          events.push({
            type: "message",
            id: `message-${item}`,
            ...(item ? { parentId: `message-${item - 1}` } : {}),
            message: {
              role: item % 2 ? "assistant" : "user",
              content: `Synthetic message ${index}/${item} `.padEnd(1024, "x"),
              ...(item % 2
                ? { stopReason: "stop", __openclaw: { runId: `synthetic-run-${index}` } }
                : {}),
            },
          });
        }
        const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
        executeSqliteQuerySync(
          database.db,
          query.insertInto("session_transcript_archives").values({
            session_id: sessionId,
            session_key: `agent:main:synthetic-${index}`,
            generation: "synthetic-generation",
            reason: "deleted",
            encoding: "identity",
            archive_blob: bytes,
            archive_sha256: createHash("sha256").update(bytes).digest("hex"),
            archive_name: `synthetic-${index}.jsonl`,
            created_at: index + 1,
            published_at: null,
          }),
        );
      }
    }, options);
  } finally {
    await agentDb.closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
  }
  console.log(JSON.stringify({ prepared: true, fixture: root, sessions, messagesPerSession }));
}

async function measureFixture() {
  process.env.OPENCLAW_BENCH_RETAINED_WORKER_DIR = output;
  if (values["owner-dir"]) {
    process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["owner-dir"]);
  } else {
    delete process.env.OPENCLAW_BENCH_BASELINE_DIR;
  }
  await import("./worker-retained-heap-preload.js");
  const { createSqliteTranscriptArchiveWorker } =
    await import("../../src/config/sessions/session-accessor.sqlite-archive.js");
  let workerFailure: Error | undefined;
  const archiveWorker = createSqliteTranscriptArchiveWorker({
    type: "sqlite-transcript-archive-v2",
    operation: "archive-session",
    env,
  });
  archiveWorker.on("error", (error) => {
    workerFailure = toStringifiedError(error);
  });
  try {
    const prefix = path.join(output, `worker-${process.pid}-${archiveWorker.threadId}`);
    async function waitJson(filename: string): Promise<Record<string, unknown>> {
      const deadline = Date.now() + 120_000;
      while (!fs.existsSync(filename)) {
        if (workerFailure) {
          throw workerFailure;
        }
        assert(archiveWorker.threadId !== -1, "Archive worker exited before its measurement reply");
        assert(Date.now() < deadline, "Archive worker measurement timed out");
        await delay(100);
      }
      const result: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
      assert(result !== null && typeof result === "object" && !Array.isArray(result));
      return result as Record<string, unknown>;
    }
    async function probe(
      id: string,
      operation: "snapshot" | "collect" | "start" | "stop",
      atEpochMs?: number,
    ) {
      const file = `${prefix}.command.json`;
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ id, operation, atEpochMs }));
      fs.renameSync(`${file}.tmp`, file);
      const result = await waitJson(`${prefix}.${id}.json`);
      assert(result.ok === true, JSON.stringify(result));
      return result;
    }
    async function request(
      operation: SqliteArchiveOperation,
    ): Promise<SqliteArchiveSessionResponse> {
      if (workerFailure) {
        throw workerFailure;
      }
      assert(archiveWorker.threadId !== -1, "Archive worker exited before its operation");
      const reply = once(archiveWorker, "message", { signal: AbortSignal.timeout(120_000) });
      archiveWorker.postMessage({ type: "archive-operation", ...operation }, []);
      // The real paired archive owner implements this private response contract.
      return (await reply)[0] as SqliteArchiveSessionResponse;
    }
    const plan = (index: number): TranscriptArchiveReadPlan => ({
      agentId: "main",
      databasePath,
      logicalAgentId: "main",
      sessionKey: `agent:main:synthetic-${index % sessions}`,
      sessionId: `synthetic-session-${index % sessions}`,
      runId: `synthetic-run-${index % sessions}`,
      expectedIdentity: undefined,
    });
    const memoryOperation = values.snapshot ? "snapshot" : "collect";
    await waitJson(`${prefix}.ready.json`);
    // Preload readiness precedes entry evaluation; an owner reply proves boot finished.
    assert((await request({ operation: "materialize", plans: [] })).type === "done");
    const cold = await probe("cold", memoryOperation);
    let firstPageColdMs: number | undefined;
    if (values["page-first"]) {
      const started = performance.now();
      const reply = await request({
        operation: "read-page",
        plans: [{ ...plan(0), limit: 20, maxBytes: 256 * 1024 }],
      });
      firstPageColdMs = performance.now() - started;
      assert(reply.type === "page-read");
      assert.equal(reply.results[0]?.entries.length, 20);
      reply.results.length = 0;
    }
    const firstFinalStarted = performance.now();
    const warmReply = await request({ operation: "read-final", plans: [plan(0)] });
    const firstFinalMs = performance.now() - firstFinalStarted;
    assert(warmReply.type === "final-read");
    assert(warmReply.results[0]?.event, "Expected archived final assistant result");
    warmReply.results.length = 0;
    const finalWarm = await probe("final-warm", memoryOperation);
    await probe("begin-final", "start", startAt);
    const timings: number[] = [];
    for (let index = 0; index < samples; index++) {
      const started = performance.now();
      const reply = await request({ operation: "read-final", plans: [plan(index)] });
      timings.push(performance.now() - started);
      assert(reply.type === "final-read");
      assert(reply.results[0]?.event, "Expected archived final assistant result");
      reply.results.length = 0;
    }
    const metrics = await probe("end-final", "stop");
    const finalIdle = await probe("final-idle", memoryOperation);
    const firstPageStarted = performance.now();
    const page = await request({
      operation: "read-page",
      plans: [{ ...plan(0), limit: 20, maxBytes: 256 * 1024 }],
    });
    const firstPageMs = performance.now() - firstPageStarted;
    assert(page.type === "page-read");
    assert.equal(page.results[0]?.entries.length, 20);
    page.results.length = 0;
    const pageWarm = await probe("page-warm", memoryOperation);
    await probe("begin-page", "start", pageStartAt);
    const pageTimings: number[] = [];
    for (let index = 0; index < samples; index++) {
      const started = performance.now();
      const reply = await request({
        operation: "read-page",
        plans: [{ ...plan(index), limit: 20, maxBytes: 256 * 1024 }],
      });
      pageTimings.push(performance.now() - started);
      assert(reply.type === "page-read");
      assert.equal(reply.results[0]?.entries.length, 20);
      reply.results.length = 0;
    }
    const pageMetrics = await probe("end-page", "stop");
    const pageIdle = await probe("page-idle", memoryOperation);
    const latency = (durations: number[]) => {
      durations.sort((left, right) => left - right);
      return {
        samples: durations.length,
        meanMs: durations.reduce((sum, ms) => sum + ms, 0) / durations.length,
        p50Ms: durations[Math.ceil(durations.length * 0.5) - 1],
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
        p99Ms: durations[Math.ceil(durations.length * 0.99) - 1],
        maxMs: durations.at(-1),
      };
    };
    const result = {
      node: process.version,
      workerThreadId: archiveWorker.threadId,
      snapshots: values.snapshot,
      fixture: { sessions, messagesPerSession },
      operations: samples,
      firstFinalMs,
      firstPageMs,
      firstPageColdMs,
      latency: latency(timings),
      pageLatency: latency(pageTimings),
      cold,
      finalWarm,
      finalIdle,
      pageWarm,
      pageIdle,
      metrics,
      pageMetrics,
    };
    const json = JSON.stringify(result, null, 2);
    fs.writeFileSync(path.join(root, "result.json"), `${json}\n`);
    console.log(json);
  } finally {
    if (archiveWorker.threadId !== -1) {
      const exited = once(archiveWorker, "exit", { signal: AbortSignal.timeout(10_000) });
      try {
        archiveWorker.postMessage({ type: "close" }, []);
        await exited;
      } catch {
        await archiveWorker.terminate();
        await exited.catch(() => {});
      }
    }
  }
}

if (values["prepare-only"]) {
  await prepareFixture();
} else {
  await measureFixture();
}
