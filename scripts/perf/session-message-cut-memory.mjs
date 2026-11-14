// Synthetic-only owning-boundary replay, under the broker's 512/32 MiB limits.
// node --import ./scripts/tsx.mjs scripts/perf/session-message-cut-memory.mjs <state-dir> [baseline-source]
// The state directory must contain agent.sqlite and only synthetic sessions.
// Rollback restores the same input after each sample. Run A/A then interleaved A/B;
// fixture creation/admission are excluded. Complete public-worker proof is separate.
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

if (isMainThread) {
  const root = path.resolve(process.argv[2]);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8")).format,
    "synthetic-message-cut-v1",
  );
  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      root,
      key: process.argv[4] ?? "oom",
      baseline: process.argv[3] && path.resolve(process.argv[3]),
    },
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 },
  });
  worker.on("message", (value) => console.log(JSON.stringify(value)));
  worker.on("error", (error) => {
    console.log(JSON.stringify({ error: error.message, code: error.code }));
    process.exitCode = 1;
  });
} else {
  const { root, baseline } = workerData;
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.OPENCLAW_HOME = root;
  const owner = new URL(
    "../../src/config/sessions/session-accessor.sqlite-message-cut.ts",
    import.meta.url,
  ).href;
  let overridden = false;
  if (baseline) {
    registerHooks({
      load(url, context, next) {
        const result = next(url, context);
        if (url !== owner) {
          return result;
        }
        overridden = true;
        return next(pathToFileURL(baseline).href, context);
      },
    });
  }
  const agent = await import("../../src/state/openclaw-agent-db.js");
  const { mutateSqliteSessionAtMessageInTransaction } =
    await import("../../src/config/sessions/session-accessor.sqlite-message-cut.js");
  const { readSessionEntryRow } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  assert(!baseline || overridden);
  const options = { agentId: "main", path: path.join(root, "agent.sqlite"), env: process.env };
  const database = agent.openOpenClawAgentDatabase(options);
  const key = `agent:main:${workerData.key}`;
  const entry = readSessionEntryRow(database, key).entry;
  let peak = 0,
    queries = 0,
    rows = 0,
    active = false;
  const sample = () => {
    peak = Math.max(peak, getHeapStatistics().used_heap_size);
  };
  const prepare = database.db.prepare.bind(database.db);
  database.db.prepare = (...args) => {
    const statement = prepare(...args);
    for (const method of ["get", "all", "run"]) {
      const original = statement[method].bind(statement);
      statement[method] = (...bindings) => {
        const result = original(...bindings);
        if (active && ++queries % 128 === 0) {
          sample();
        }
        return result;
      };
    }
    const iterate = statement.iterate.bind(statement);
    statement.iterate = function* (...bindings) {
      for (const row of iterate(...bindings)) {
        if (active && ++rows % 128 === 0) {
          sample();
        }
        yield row;
      }
    };
    return statement;
  };
  const rollback = new Error("synthetic measurement rollback");
  globalThis.gc?.();
  const inspector = process.env.OOM_ALLOCATIONS ? new Session() : undefined;
  if (inspector) {
    await startCollectedHeapSampling(inspector, 16384);
  }
  const before = getHeapStatistics(),
    cpu = process.threadCpuUsage(),
    start = performance.now();
  let outcome;
  active = true;
  try {
    agent.runOpenClawAgentWriteTransaction(() => {
      outcome = mutateSqliteSessionAtMessageInTransaction(
        database,
        { ...options, sessionKey: key },
        {
          canonicalSourceKey: key,
          sourceKey: key,
          targetKey: key,
          entryId: "e2",
          mode: "rewind",
          expectedState: { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
        },
        { scheduleProjectionReconcile: false },
      );
      sample();
      assert.equal(outcome.status, "created");
      if (process.env.OOM_VERIFY) {
        const target = outcome.entry.sessionId;
        const count = database.db.prepare(
          "SELECT count(*) AS n FROM transcript_events WHERE session_id=?",
        );
        const sourceCount = count.get(entry.sessionId).n;
        assert.equal(typeof sourceCount, "number");
        assert.equal(count.get(target).n, Number(sourceCount) + 1);
        assert.equal(
          database.db
            .prepare(
              "SELECT count(*) AS n FROM transcript_events a JOIN transcript_events b ON a.seq=b.seq WHERE a.session_id=? AND b.session_id=? AND a.seq>0 AND (a.event_json IS NOT b.event_json OR a.event_zstd IS NOT b.event_zstd OR a.event_utf8_bytes IS NOT b.event_utf8_bytes)",
            )
            .get(entry.sessionId, target).n,
          0,
        );
        parentPort.postMessage({ verifiedPayloadRows: Number(sourceCount) - 1 }, []);
      }
      assert.equal(outcome.editorText, "x".repeat(Number(process.env.OOM_EVENT_BYTES ?? 32768)));
      throw rollback;
    }, options);
  } catch (error) {
    if (error !== rollback) {
      throw error;
    }
  }
  active = false;
  const elapsed = performance.now() - start,
    used = process.threadCpuUsage(cpu),
    after = getHeapStatistics();
  const sampledAllocationBytes = inspector
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  inspector?.disconnect();
  assert.equal(readSessionEntryRow(database, key).entry.sessionId, entry.sessionId);
  parentPort.postMessage(
    {
      arm: baseline ? "baseline" : "candidate",
      sampledAllocationBytes,
      verificationIncluded: Boolean(process.env.OOM_VERIFY),
      elapsedMs: elapsed,
      cpuMs: (used.user + used.system) / 1000,
      heapBefore: before.used_heap_size,
      peakHeap: peak,
      heapAfter: after.used_heap_size,
      allocatedBytes: after.total_allocated_bytes - before.total_allocated_bytes,
      queries,
      rows,
      load: loadavg(),
      heapLimit: after.heap_size_limit,
      node: process.version,
    },
    [],
  );
  await agent.closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
