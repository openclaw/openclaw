/**
 * Capture actual transcript-owner SQL, never copied query text, on two 20k-event sessions.
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-plan-stats.ts --mode plans
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-plan-stats.ts
 *   --mode timing --request recent --iterations 2000 [--baseline-dir <saved-source-root>]
 * Repeat with --mode allocation separately; counterbalance base/candidate timing passes.
 * Requests: recent, visible-tail, previous-indexed, historical, replay.
 * Fixture setup/warmup are excluded. Accept identical results and eliminated payload
 * scans/sorts with lower CPU/read; sampled allocation and traced GC are context only.
 * --mode plans covers no statistics, full ANALYZE, and partial production-shaped stat1.
 * Output is JSON; fixture files stay under .local and are deleted on completion.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "plans" },
    request: { type: "string", default: "recent" },
    iterations: { type: "string", default: "2000" },
    "baseline-dir": { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2000,
  min: 1,
  label: "iterations",
});
assert(["plans", "timing", "allocation"].includes(values.mode));
const sourceHash = createHash("sha256");
const baseline = values["baseline-dir"] && path.resolve(values["baseline-dir"]);
for (const owner of ["projection-read", "history-interval", "suffix-read", "active-context"]) {
  const file = `src/config/sessions/session-accessor.sqlite-${owner}.ts`;
  const saved = baseline && path.join(baseline, file);
  sourceHash.update(file).update(readFileSync(saved && existsSync(saved) ? saved : file));
}
const replayFile = "src/config/sessions/session-transcript-replay.kernel.ts";
const savedReplay = baseline && path.join(baseline, replayFile);
sourceHash
  .update(replayFile)
  .update(readFileSync(savedReplay && existsSync(savedReplay) ? savedReplay : replayFile));
if (baseline) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = baseline;
  await import("./worker-retained-heap-preload.ts");
}
const { applyTranscriptPlanStatistics, captureTranscriptSql, seedTranscriptPlanStatsFixture } =
  await import("../../test/helpers/transcript-plan-stats.js");
const { openOpenClawAgentDatabase, runOpenClawAgentWriteTransaction } =
  await import("../../src/state/openclaw-agent-db.js");
const { requireNativeSqliteDatabase } = await import("../../src/test-utils/native-sqlite.js");
const { cleanupSessionStateForTest } =
  await import("../../src/test-utils/session-state-cleanup.js");
const { readCurrentProjectionSnapshot } =
  await import("../../src/config/sessions/session-accessor.sqlite-projection-read.js");
const { withRecentSessionTranscriptActiveEventsInSnapshot } =
  await import("../../src/config/sessions/session-accessor.sqlite-active-events-read.js");
const { readTranscriptVisibleTailEntryIdInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-parent.js");
const { readLatestAssistantTextFromDatabase } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-metadata-read.js");
const { resolveClosedResetInterval } =
  await import("../../src/config/sessions/session-accessor.sqlite-closed-reset-interval.js");
const { readHistoricalHistoryAnchorPage } =
  await import("../../src/config/sessions/session-accessor.sqlite-history-interval.js");
const { readLatestActiveResetBoundary } =
  await import("../../src/config/sessions/session-accessor.sqlite-reset-window.js");
const { readCacheTtlProjectionPrefix } =
  await import("../../src/config/sessions/session-cache-ttl-prefix.js");
const { readPendingInputSourceInDatabase } =
  await import("../../src/config/sessions/session-pending-input-source.kernel.js");
const { readPendingInputHistoryInDatabase } =
  await import("../../src/config/sessions/session-pending-input-history.kernel.js");
const { listSessionsNeedingTranscriptIndexReconcile } =
  await import("../../src/config/sessions/session-transcript-index.js");
const { readSessionTranscriptBoundedActiveContextCore } =
  await import("../../src/config/sessions/session-accessor.sqlite-active-context.js");
const { readPreviousIndexedTranscriptEventSync } =
  await import("../../src/config/sessions/session-accessor.sqlite-suffix-read.js");
const { prepareIncrementalSuffixIdempotencyMutation } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-suffix-idempotency.js");
const { replaceSqliteTranscriptSuffixInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-suffix.js");
const { readSessionTranscriptReplayGroupsCore } =
  await import("../../src/config/sessions/session-transcript-replay.kernel.js");
mkdirSync(".local", { recursive: true });
const stateDir = mkdtempSync(path.resolve(".local/transcript-plan-stats-"));
const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
const scope = { agentId: "synthetic", sessionId: "long", sessionKey: "agent:synthetic:long", env };
try {
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env });
  const db = requireNativeSqliteDatabase(database.db);
  const count = 20_000;
  const events = seedTranscriptPlanStatsFixture(db, count);
  const snapshot = readCurrentProjectionSnapshot(database, scope, (value) => value);
  assert(snapshot.kind === "value");
  const projection = snapshot.value;
  const rollback = new Error("synthetic suffix rollback");
  const requests: Record<string, () => unknown> = {
    projection: () => readCurrentProjectionSnapshot(database, scope, (value) => value.state),
    recent: () =>
      withRecentSessionTranscriptActiveEventsInSnapshot(projection, 20, (visit) => {
        const result: unknown[] = [];
        visit((event) => result.push(event));
        return result;
      }),
    "visible-tail": () =>
      readTranscriptVisibleTailEntryIdInTransaction(
        database,
        scope.sessionId,
        `event-${count - 1}`,
      ),
    assistant: () => readLatestAssistantTextFromDatabase(database, scope),
    "closed-reset": () =>
      resolveClosedResetInterval(projection, { activePosition: count - 150, eventType: "message" }),
    historical: () =>
      readHistoricalHistoryAnchorPage(
        projection,
        undefined,
        { active_position: count - 250, event_type: "message" },
        { messageId: `event-${count - 250}`, maxMessages: 20 },
      ),
    reset: () => readLatestActiveResetBoundary({ ...projection, latestIndexedReset: undefined }),
    "cache-ttl": () =>
      readCacheTtlProjectionPrefix(projection, {
        activePosition: count - 1,
        id: `event-${count - 1}`,
        entry: { type: "message" },
      }),
    "pending-source": () =>
      readPendingInputSourceInDatabase(database, {
        ...scope,
        kind: "source",
        pendingOnly: false,
        idempotencyKey: "committed",
      }),
    "pending-history": () =>
      readPendingInputHistoryInDatabase(database, { ...scope, includeTotal: false, limit: 20 }),
    index: () => listSessionsNeedingTranscriptIndexReconcile(db, 20),
    "active-context": () => {
      db.exec("BEGIN");
      try {
        return readSessionTranscriptBoundedActiveContextCore(scope, {
          maxEvents: 20,
          maxBytes: 100000,
          transaction: database,
          resolvedScope: scope,
        });
      } finally {
        db.exec("ROLLBACK");
      }
    },
    "previous-indexed": () => readPreviousIndexedTranscriptEventSync(scope, count - 2),
    "suffix-idempotency": () =>
      prepareIncrementalSuffixIdempotencyMutation({
        database,
        resolved: scope,
        startSeq: count - 2,
        expectedRows: [
          { seq: count - 2, createdAt: 1, eventJson: "" },
          { seq: count - 1, createdAt: 1, eventJson: "" },
        ],
        next: [],
      }),
    replay: () =>
      readSessionTranscriptReplayGroupsCore(scope, {
        entryIds: [`event-${count - 21}`],
        maxBytes: 100000,
      }),
    "suffix-full": () => {
      try {
        runOpenClawAgentWriteTransaction(
          (current) => {
            replaceSqliteTranscriptSuffixInTransaction(
              current,
              scope,
              { expectedEvents: events, nextEvents: events.slice(0, -2) },
              { scheduleProjectionReconcile: false },
            );
            throw rollback;
          },
          { agentId: scope.agentId, env },
        );
      } catch (error) {
        if (error !== rollback) {
          throw error;
        }
      }
    },
  };
  if (values.mode === "plans") {
    const results = new Map<string, unknown>();
    const captured = new Map<string, Map<string, { sql: string; columns: string[] }>>();
    const statisticsStates = ["none", "analyzed", "team"] as const;
    for (const statistics of statisticsStates) {
      applyTranscriptPlanStatistics(db, statistics);
      for (const [name, read] of Object.entries(requests)) {
        const { result, queries } = captureTranscriptSql(db, read);
        if (results.has(name)) {
          assert.deepEqual(result, results.get(name));
        } else {
          results.set(name, result);
        }
        let retained = captured.get(name);
        if (!retained) {
          retained = new Map();
          captured.set(name, retained);
        }
        for (const query of queries) {
          retained.set(query.sql, query);
        }
      }
    }
    // Warm owner facts can skip later SQL; explain the entire captured union in every state.
    const reports = [];
    for (const statistics of statisticsStates) {
      applyTranscriptPlanStatistics(db, statistics);
      for (const [name, queries] of captured) {
        reports.push({
          name,
          statistics,
          queries: [...queries.values()].map((query) => ({
            sql: query.sql,
            columns: query.columns,
            plan: db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(),
          })),
        });
      }
    }
    console.log(JSON.stringify({ sourceHash: sourceHash.digest("hex"), reports }));
  } else {
    assert(globalThis.gc, "Use --expose-gc for timing/allocation passes");
    const read = requests[values.request];
    assert(read, "Unknown request");
    applyTranscriptPlanStatistics(db, "team");
    const expected = read();
    for (let index = 0; index < 30; index++) {
      read();
    }
    globalThis.gc();
    const inspector = values.mode === "allocation" ? new Session() : undefined;
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const gc = new GCProfiler();
    gc.start();
    const hostLoadBefore = loadavg();
    const memoryBefore = process.memoryUsage();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    let last: unknown;
    for (let index = 0; index < iterations; index++) {
      last = read();
    }
    const elapsedMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    const collections = gc.stop()?.statistics ?? [];
    const memoryAfter = process.memoryUsage();
    let allocatedBytesPerOp: number | undefined;
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      inspector.disconnect();
      allocatedBytesPerOp =
        profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
    }
    assert.deepEqual(last, expected);
    console.log(
      JSON.stringify({
        request: values.request,
        mode: values.mode,
        sourceHash: sourceHash.digest("hex"),
        responseDigest: createHash("sha256")
          .update(JSON.stringify(last) ?? "undefined")
          .digest("hex"),
        iterations,
        elapsedMs,
        cpuUsPerOp: (used.user + used.system) / iterations,
        allocatedBytesPerOp,
        gc: collections,
        memoryBefore,
        memoryAfter,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
        node: process.version,
      }),
    );
  }
} finally {
  await cleanupSessionStateForTest({ stateDir });
  rmSync(stateDir, { recursive: true, force: true });
}
