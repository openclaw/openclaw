/**
 * Version-maintenance reads across interleaved synthetic sessions with saved prompts.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-maintenance-measure.ts
 *   [--iterations 2000] [--sessions 32] [--prompt-bytes 131072] [--allocations]
 *   [--owner /absolute/base-session-transcript-maintenance-read.ts]
 * Alternate base/candidate processes (five each); sample allocations separately.
 * Accept identical results and unchanged stored-row digests with lower CPU/allocation.
 * Warm owner timing excludes fixture setup and statement tracing; this is not a
 * whole-Gateway or cold-disk latency claim. Fixtures live under .local and are removed.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
    sessions: { type: "string", default: "32" },
    "prompt-bytes": { type: "string", default: "131072" },
    allocations: { type: "boolean", default: false },
  },
});
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const iterations = integer(values.iterations, "iterations");
const sessions = integer(values.sessions, "sessions");
const promptBytes = integer(values["prompt-bytes"], "prompt-bytes");
const ownerUrl = new URL(
  "../../src/config/sessions/session-transcript-maintenance-read.ts",
  import.meta.url,
);
let replaced = false;
if (values.owner) {
  const replacement = pathToFileURL(path.resolve(values.owner)).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl.href) {
        return nextLoad(url, context);
      }
      replaced = true;
      const loaded = nextLoad(replacement, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const parent = path.resolve(".local");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "maintenance-measure-"));
const env = { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_HOME: root };
Object.assign(process.env, { OPENCLAW_STATE_DIR: root, OPENCLAW_HOME: root });
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot({
  logging: { level: "silent", consoleLevel: "silent", file: path.join(root, "run.log") },
});
const agent = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { replaceSessionEntryInDatabase } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-mutation.js");
const { replaceSqliteTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
const { runWithSqliteWorkerStateContext } =
  await import("../../src/infra/sqlite-worker-state-context.js");
const { startSqliteStatementTiming } =
  await import("../../src/infra/database-engine/observation.js");
const { readSessionTranscriptMaintenance: read } =
  await import("../../src/config/sessions/session-transcript-maintenance-read.js");
assert(!values.owner || replaced, "Baseline override did not load");
const digest = (value: unknown) => hash("sha256", JSON.stringify(value), "hex");
try {
  await runWithSqliteWorkerStateContext({ environment: env }, async () => {
    const options = { agentId: "main", env, path: path.join(root, "agent.sqlite") };
    const database = agent.openOpenClawAgentDatabase(options);
    const targets = Array.from({ length: sessions }, (_, i) => ({
      agentId: "main",
      storePath: database.path,
      env,
      sessionId: `synthetic-${i}`,
      sessionKey: `agent:main:synthetic-${i}`,
    }));
    agent.runOpenClawAgentWriteTransaction(() => {
      for (const [index, target] of targets.entries()) {
        replaceSessionEntryInDatabase(database, target.sessionKey, {
          sessionId: target.sessionId,
          updatedAt: 1,
          lifecycleRevision: `revision-${index}`,
          skillsSnapshot: { prompt: "synthetic ".padEnd(promptBytes, "x"), skills: [] },
        });
        replaceSqliteTranscriptEventsInTransaction(
          database,
          target,
          [
            {
              type: "session",
              id: target.sessionId,
              version: 3,
              timestamp: "2026-01-01T00:00:00.000Z",
              cwd: "/synthetic",
            },
            ...Array.from({ length: 128 }, (_, seq) => ({
              type: "message",
              id: `event-${seq}`,
              parentId: seq ? `event-${seq - 1}` : null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: {
                role: seq % 2 ? "assistant" : "user",
                content: `Synthetic ${seq}`.padEnd(1024, "x"),
              },
            })),
          ],
          { rebuildProjectionSynchronously: true, scheduleProjectionReconcile: false },
        );
      }
    }, options);
    // All values below are synthetic. Read full rows outside the timed section only.
    const storedDigest = () =>
      digest([
        database.db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
        database.db
          .prepare("SELECT * FROM session_entry_snapshots ORDER BY session_key, field")
          .all(),
        database.db.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(),
      ]);
    const beforeDigest = storedDigest();
    const expected = targets.map((target, index) => {
      const result = read(database, target, { operation: "version" });
      assert.equal(result.lifecycleRevision, `revision-${index}`);
      assert.equal(result.appendParentId, "event-127");
      assert.equal(result.version?.rawSeq, 128);
      return result;
    });
    const statements: Array<{ sql: string; durationMs: number }> = [];
    const observe = (value: unknown) => {
      if (
        isRecord(value) &&
        typeof value.sql === "string" &&
        typeof value.durationMs === "number"
      ) {
        statements.push({ sql: value.sql, durationMs: value.durationMs });
      }
    };
    const events = channel("openclaw.database.statement");
    events.subscribe(observe);
    const stop = startSqliteStatementTiming();
    try {
      read(database, targets[0]!, { operation: "version" });
    } finally {
      events.unsubscribe(observe);
      stop();
    }
    globalThis.gc?.();
    await setImmediate();
    const gc: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gc.push(entry.duration);
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    const inspector = new Session();
    if (values.allocations) {
      await startCollectedHeapSampling(inspector, 4096);
    }
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    const durations: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const index = i % sessions;
      const before = performance.now();
      const result = read(database, targets[index]!, { operation: "version" });
      durations.push(performance.now() - before);
      assert.deepEqual(result, expected[index]);
    }
    const elapsedMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    const allocatedBytes = values.allocations
      ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
    if (values.allocations) {
      inspector.disconnect();
    }
    await setImmediate();
    await setImmediate();
    observer.disconnect();
    assert.equal(storedDigest(), beforeDigest);
    const sorted = durations.toSorted((a, b) => a - b);
    console.log(
      JSON.stringify({
        iterations,
        sessions,
        promptBytes,
        sourceSha256: hash("sha256", await readFile(values.owner ?? ownerUrl), "hex"),
        elapsedMs,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes,
        latencyMs: {
          p50: sorted[Math.floor(iterations * 0.5)],
          p95: sorted[Math.floor(iterations * 0.95)],
          p99: sorted[Math.floor(iterations * 0.99)],
          samples: iterations,
        },
        gcMs: gc.reduce((sum, ms) => sum + ms, 0),
        gcCount: gc.length,
        gcMaxMs: Math.max(0, ...gc),
        memory: process.memoryUsage(),
        hostLoad,
        storedRowsUnchanged: true,
        statements,
      }),
    );
  });
} finally {
  await agent.closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
  await rm(root, { recursive: true, force: true });
}
