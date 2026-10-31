// Borrowed transcript receipt owner, with real SQLite admission and synthetic metadata.
// node --import ./scripts/tsx.mjs scripts/perf/transcript-projection-receipt-measure.ts \
//   --output .local/receipt-candidate --mode timing --rows 0,512,4096 --iterations 2000
// Add --owner-file .local/buf174/base-scope.ts for the exact baseline owner's source.
// Repeat in counterbalanced order with --mode allocation; timing excludes sampling.
// Acceptance: equal projected facts, less allocation, no material untraced CPU regression.
// Setup is excluded. This measures receipt reads, not Gateway load or transcript decoding.
// Zero rows is the ordinary compact receipt; nonzero shapes measure metadata capacity cases.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { constants, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { SessionTranscriptProjectionReceipt } from "../../src/config/sessions/session-transcript-projection-facts.types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "owner-file": { type: "string" },
    mode: { type: "string", default: "timing" },
    rows: { type: "string", default: "0,512,4096" },
    iterations: { type: "string", default: "2000" },
  },
});
assert(values.output, "--output must name a new directory");
assert(values.mode === "timing" || values.mode === "allocation", "Invalid --mode");
const iterations = Number(values.iterations);
const rowCounts = values.rows.split(",").map(Number);
assert(Number.isSafeInteger(iterations) && iterations > 0, "Iterations must be a positive integer");
for (const count of rowCounts) {
  assert(Number.isSafeInteger(count) && count >= 0, "Row counts must be nonnegative integers");
}
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
const env = {
  HOME: path.join(output, "home"),
  OPENCLAW_HOME: path.join(output, "home"),
  OPENCLAW_STATE_DIR: path.join(output, "state"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
for (const directory of [env.HOME, env.OPENCLAW_STATE_DIR]) {
  mkdirSync(directory, { recursive: true });
}
Object.assign(process.env, env);
const ownerUrl = new URL(
  "../../src/config/sessions/session-transcript-projection-facts-scope.ts",
  import.meta.url,
);
const sourceUrl = values["owner-file"]
  ? pathToFileURL(path.resolve(values["owner-file"]))
  : ownerUrl;
let ownerLoaded = false;
if (values["owner-file"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ownerUrl.href) {
        ownerLoaded = true;
        const loaded = nextLoad(sourceUrl.href, context);
        return { format: loaded.format, source: loaded.source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
const { readSessionTranscriptProjectionReceipt: read, withSessionTranscriptProjectionReceipt } =
  await import("../../src/config/sessions/session-transcript-projection-facts-scope.js");
assert(!values["owner-file"] || ownerLoaded, "Baseline owner substitution was not loaded");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { readSqliteDatabaseScopedWriteToken, sqliteSessionIdWriteScope } =
  await import("../../src/infra/sqlite-database-admission.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");

function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
}
function factsJson(receipt: NonNullable<ReturnType<typeof read>>) {
  return JSON.stringify({
    facts: receipt.facts,
    contextStats: receipt.contextStats,
    contextOnly: receipt.contextOnly,
  });
}
const inspector = new Session();
try {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: process.env });
  const sessionId = "synthetic-receipt";
  const writeScopes = [sqliteSessionIdWriteScope(sessionId)];
  const writeToken = readSqliteDatabaseScopedWriteToken(database.db, writeScopes);
  assert(writeToken, "Opened database did not publish an admitted write token");
  if (values.mode === "allocation") {
    inspector.connect();
  }
  const results = [];
  for (const rowCount of rowCounts) {
    const eventCount = rowCount || 4096;
    const receipt: SessionTranscriptProjectionReceipt = {
      sessionId,
      writeScopes,
      writeToken,
      facts: {
        cold: false,
        generation: "synthetic-generation",
        updatedAt: 1,
        hasUnclassified: false,
        latestIndexedReset: null,
        hasUnindexedPrefix: false,
        latestSeq: eventCount,
        state: {
          activeEventCount: eventCount,
          activeMessageCount: eventCount,
          indexedSeq: eventCount,
          leafEventId: `message-${eventCount}`,
          needsRebuild: false,
        },
        contextMetadata: rowCount
          ? {
              header: { seq: 0, navigation_valid: 1, serialized_bytes: 80 },
              rows: Array.from({ length: rowCount }, (_, index) => ({
                event_seq: index + 1,
                active_position: index,
                serialized_bytes: 4096,
              })),
              boundaryCount: 0,
              eventCount: rowCount,
              sizeBytes: rowCount * 4096,
            }
          : undefined,
      },
      contextStats: {
        eventCount,
        sizeBytes: eventCount * 4096,
        boundaryActivePosition: -1,
      },
    };
    const readTask = () =>
      withSessionTranscriptProjectionReceipt(receipt, () => read(database, sessionId));
    let latest = readTask();
    assert(latest?.facts, "Synthetic receipt was not admitted");
    const golden = factsJson(latest);
    for (let index = 0; index < 32; index++) {
      readTask();
    }
    await setImmediate();
    const pauses: Array<{ startTime: number; duration: number; kind: unknown }> = [];
    const collect = (
      entries: readonly { startTime: number; duration: number; detail?: unknown }[],
    ) => {
      for (const entry of entries) {
        pauses.push({
          startTime: entry.startTime,
          duration: entry.duration,
          kind: isRecord(entry.detail) ? entry.detail.kind : undefined,
        });
      }
    };
    const observer = new PerformanceObserver((list) => collect(list.getEntries()));
    observer.observe({ entryTypes: ["gc"] });
    if (values.mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 8192,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const memoryBefore = process.memoryUsage();
    const loadBefore = os.loadavg();
    const cpuBefore = process.threadCpuUsage();
    const started = performance.now();
    let observedRows = 0;
    let observedEvents = 0;
    for (let index = 0; index < iterations; index++) {
      latest = readTask();
      observedRows += latest?.facts?.contextMetadata?.rows.length ?? 0;
      observedEvents += latest?.contextStats?.eventCount ?? -1;
    }
    const ended = performance.now();
    const cpu = process.threadCpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();
    const sampled =
      values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
    await setImmediate();
    await setImmediate();
    collect(observer.takeRecords());
    observer.disconnect();
    assert(latest);
    assert.equal(observedRows, iterations * rowCount);
    assert.equal(observedEvents, iterations * eventCount);
    assert.equal(factsJson(latest), golden, "Receipt projection changed during measurement");
    const measuredPauses = pauses.filter(
      (entry) => entry.startTime >= started && entry.startTime < ended,
    );
    const gc = Object.fromEntries(
      Object.entries({
        total: undefined,
        minor: constants.NODE_PERFORMANCE_GC_MINOR,
        major: constants.NODE_PERFORMANCE_GC_MAJOR,
        incremental: constants.NODE_PERFORMANCE_GC_INCREMENTAL,
        weakCallback: constants.NODE_PERFORMANCE_GC_WEAKCB,
      }).map(([kind, code]) => {
        const durations = measuredPauses
          .filter((entry) => code === undefined || entry.kind === code)
          .map((entry) => entry.duration)
          .toSorted((left, right) => left - right);
        return [
          kind,
          {
            count: durations.length,
            totalMs: durations.reduce((sum, duration) => sum + duration, 0),
            maxMs: durations.at(-1) ?? 0,
            p95Ms: durations[Math.ceil(durations.length * 0.95) - 1] ?? 0,
            p99Ms: durations[Math.ceil(durations.length * 0.99) - 1] ?? 0,
          },
        ];
      }),
    );
    const result = {
      scope: "Synthetic receipt reads with real SQLite admission; not whole-Gateway evidence",
      node: process.version,
      mode: values.mode,
      ownerSha256: hash("sha256", readFileSync(sourceUrl)),
      ownerReplacement: ownerLoaded,
      iterations,
      rowCount,
      shape: rowCount ? "metadata-capacity" : "compact",
      observedRows,
      factBytes: Buffer.byteLength(golden),
      factSha256: hash("sha256", golden),
      wallMs: ended - started,
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuUsPerRead: (cpu.user + cpu.system) / iterations,
      timingGateEligible: values.mode === "timing",
      allocatedBytes: sampled ? allocatedBytes(sampled.profile.head) : undefined,
      allocatedBytesPerRead: sampled
        ? allocatedBytes(sampled.profile.head) / iterations
        : undefined,
      samplingInterval: sampled ? 8192 : undefined,
      gc,
      memoryBefore,
      memoryAfter,
      loadBefore,
      loadAfter: os.loadavg(),
    };
    results.push(result);
    if (sampled) {
      writeFileSync(
        path.join(output, `allocation-${rowCount}.heapprofile`),
        JSON.stringify(sampled.profile),
      );
    }
    console.log(JSON.stringify(result));
  }
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
