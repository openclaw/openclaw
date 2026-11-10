/**
 * Current-session projection ownership, with synthetic persisted entries and config revisions.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-projection-retention.ts \
 *   --output .local/projection/result.json --sessions 700 --batches 20
 * Repeat serially with 5000 sessions; --allocation is a separate instrumented pass.
 * All sessions are unarchived; --active counts sessions updated per batch, not running agents.
 * Heap deltas cover the process. Plain-data estimates exclude closures/native backing stores
 * and can truncate; neither metric is a dominator-retained size or a production extrapolation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { retainSessionListForegroundWork } from "../../src/gateway/session-projection-work.js";
import { createSessionRowProjection } from "../../src/gateway/session-row-projection.js";
import { listProjectedSessions } from "../../src/gateway/session-utils-list.js";
import {
  emitInternalDiagnosticEvent,
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../src/infra/diagnostic-events.js";
import { estimateRetainedDataSize } from "../../src/infra/retained-data-size.js";
import { readGlobalSingleton } from "../../src/shared/global-singleton.js";
import { runOpenClawAgentWriteTransaction } from "../../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { collectForRetentionCheck, expectCollected } from "../../src/test-utils/retention.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    sessions: { type: "string", default: "700" },
    active: { type: "string", default: "19" },
    batches: { type: "string", default: "20" },
    churn: { type: "string", default: "32" },
    allocation: { type: "boolean" },
    snapshot: { type: "boolean" },
    diagnostics: { type: "boolean" },
    "read-all": { type: "boolean" },
    "cpu-profile": { type: "boolean" },
    "expect-config-collected": { type: "boolean" },
  },
});
assert(values.output, "--output must name a synthetic result file");
assert(global.gc, "Use --expose-gc");
assert(!(values.allocation && values["cpu-profile"]), "Profile CPU and allocation separately");
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
const number = (name: "sessions" | "active" | "batches" | "churn", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: name, fallback, min: 1 });
const sessions = number("sessions", 700),
  active = number("active", 19);
const batches = number("batches", 20),
  churn = number("churn", 32);
assert(active <= sessions);
const key = (index: number) => `agent:main:projection-fixture-${index}`;
function config(revision: number): OpenClawConfig {
  return {
    agents: { entries: { main: { identity: { name: `Synthetic revision ${revision}` } } } },
    plugins: { enabled: false },
    skills: {
      entries: Object.fromEntries(
        Array.from({ length: 128 }, (_, index) => [
          `fixture-skill-${index}`,
          {
            enabled: true,
            config: {
              description: `Synthetic config ${index}: ${"A local analysis task. ".repeat(24)}`,
            },
          },
        ]),
      ),
    },
  };
}
function entry(index: number, revision: number): InternalSessionEntry {
  return {
    sessionId: `projection-fixture-${index}`,
    updatedAt: 1_800_000_000_000 + revision,
    label: `Synthetic session ${index} revision ${revision}`,
    visibility: "shared",
    category: `project-${index % 12}`,
    modelProvider: "synthetic",
    model: "fixture-model",
    inputTokens: 20_000 + index,
    outputTokens: 1000,
    totalTokens: 21_000 + index,
    totalTokensFresh: true,
    contextTokens: 128_000,
    skillsSnapshot: {
      prompt: `Session ${index}: ${"Synthetic task guidance. ".repeat(96)}`,
      skills: Array.from({ length: 16 }, (_, skill) => ({ name: `fixture-skill-${skill}` })),
      version: 1,
    },
  };
}
const sourceHashes = Object.fromEntries(
  [
    "src/gateway/server-methods/session-placement-read-projection.ts",
    "src/gateway/session-row-projection-materialize.ts",
    "src/gateway/session-row-projection.ts",
    "src/gateway/session-row-projection-context.ts",
    "src/gateway/session-row-projection-publication.ts",
    "src/infra/retained-data-size.ts",
  ].map((name) => {
    const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
    const source =
      baseline && existsSync(path.join(baseline, name)) ? path.join(baseline, name) : name;
    return [name, createHash("sha256").update(readFileSync(source)).digest("hex")];
  }),
);
const checkpoints: Array<Record<string, unknown>> = [];
const result: Record<string, unknown> = {
  scope:
    "Synthetic current-session projection owner; no Gateway, model, workspace tree or production database",
  node: process.version,
  sourceHashes,
  sessions,
  activeUpdatedSessions: active,
  batches,
  churn,
  allocation: Boolean(values.allocation),
  readAllPerBatch: Boolean(values["read-all"]),
  cpuProfile: Boolean(values["cpu-profile"]),
  loadStart: loadavg(),
  checkpoints,
  configJsonBytes: Buffer.byteLength(JSON.stringify(config(0))),
  entryJsonBytes: Buffer.byteLength(JSON.stringify(entry(0, 0))),
  configReferenceScope:
    "Track replaced reload configurations; creation params retain the initial config and fixture owns current config",
};
await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
  let cfg = config(0);
  setRuntimeConfigSnapshot(cfg);
  runOpenClawAgentWriteTransaction(
    (db) => {
      for (let index = 0; index < sessions; index++) {
        writeSessionEntry(db, key(index), entry(index, 0));
      }
    },
    { agentId: "main" },
  );
  const countListeners = () => {
    const listeners = readGlobalSingleton(Symbol.for("openclaw.sessionRowProjectionChanges"));
    assert(listeners instanceof Set);
    return listeners.size;
  };
  const listenerCount = countListeners();
  const release = retainSessionListForegroundWork();
  await collectForRetentionCheck("seeded");
  const seededHeap = process.memoryUsage().heapUsed;
  const coldStarted = performance.now(),
    coldCpu = process.threadCpuUsage();
  const projection = await createSessionRowProjection({
    cfg,
    getConfig: () => cfg,
    modelCatalog: [],
  });
  const inspector = new Session();
  const retiredConfigs: WeakRef<object>[] = [];
  let diagnostic:
    | { projections: number; entries: number; estimatedBytes: number; truncatedProjections: number }
    | undefined;
  const stopDiagnostics = values.diagnostics
    ? onInternalDiagnosticEvent(
        (event) => {
          if (event.type === "sessions.projection.retention") {
            diagnostic = {
              projections: event.projections,
              entries: event.entries,
              estimatedBytes: event.estimatedBytes,
              truncatedProjections: event.truncatedProjections,
            };
          }
        },
        { include: ["sessions.projection.retention"] },
      )
    : () => {};
  const readDiagnostic = async (expectedEntries: number) => {
    if (!values.diagnostics) {
      return undefined;
    }
    if (values.allocation) {
      await startCollectedHeapSampling(inspector, 8192);
    }
    const started = performance.now(),
      cpu = process.threadCpuUsage();
    const memory = process.memoryUsage();
    emitInternalDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory: {
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
    });
    await waitForDiagnosticEventsDrained();
    // A memory sample queues a second event; the drain waits only for its initial sequence.
    await waitForDiagnosticEventsDrained();
    const used = process.threadCpuUsage(cpu),
      elapsedMs = performance.now() - started;
    let allocatedBytes: number | undefined;
    if (values.allocation) {
      allocatedBytes = sumSampledHeapBytes(
        (await inspector.post("HeapProfiler.stopSampling")).profile.head,
      );
      inspector.disconnect();
    }
    assert.equal(diagnostic?.entries, expectedEntries);
    return { ...diagnostic, elapsedMs, cpuMs: (used.user + used.system) / 1000, allocatedBytes };
  };
  const captureRows = (
    selected: (row: ReturnType<typeof projection.selectEntries>[number]) => boolean,
  ) => {
    const refs: WeakRef<object>[] = [];
    for (const row of projection.selectEntries()) {
      if (selected(row)) {
        refs.push(new WeakRef(row));
        if (row.materialized) {
          refs.push(new WeakRef(row.materialized));
        }
      }
    }
    return refs;
  };
  const allIndices = Array.from({ length: sessions }, (_, index) => index);
  const describeCurrent = (indices = allIndices) => {
    for (const index of indices) {
      assert.equal(
        projection.describe({ agentId: "main", key: key(index) })?.materialized.source.cfg,
        cfg,
      );
    }
  };
  const inventory = () => {
    const rows = projection.selectEntries();
    assert.equal(rows.length, sessions);
    const configSources = new Set(
      rows.flatMap((row) => (row.materialized ? [row.materialized.source.cfg] : [])),
    );
    const estimate = estimateRetainedDataSize(rows);
    const staleMaterializedConfigs = rows.filter(
      (row) => row.materialized && row.materialized.source.cfg !== cfg,
    ).length;
    if (values["expect-config-collected"]) {
      assert.equal(staleMaterializedConfigs, 0);
    }
    return {
      staleMaterializedConfigs,
      rows: rows.length,
      materialized: rows.filter((row) => row.materialized).length,
      facts: rows.filter((row) => row.facts).length,
      materializedConfigSources: configSources.size,
      rowDataEstimate: estimate,
      estimatedBytesPerRow: estimate.approximateBytes / rows.length,
      firstRowOwnKeys: Object.keys(rows[0] ?? {}),
    };
  };
  const readPage = () =>
    listProjectedSessions({
      projection,
      opts: { limit: 100, archived: false },
      acceptsSerializedJson: true,
    });
  try {
    await projection.ensureMaterialized();
    describeCurrent();
    await readPage();
    const coldUsed = process.threadCpuUsage(coldCpu);
    result.cold = {
      elapsedMs: performance.now() - coldStarted,
      cpuMs: (coldUsed.user + coldUsed.system) / 1000,
    };
    await collectForRetentionCheck("warm");
    const warmHeap = process.memoryUsage().heapUsed;
    result.seededHeap = seededHeap;
    result.warmHeap = warmHeap;
    result.projectionHeapDelta = warmHeap - seededHeap;
    result.projectionHeapDeltaPerSession = (warmHeap - seededHeap) / sessions;
    result.initial = inventory();
    result.initialDiagnostic = await readDiagnostic(sessions);
    if (values["cpu-profile"]) {
      inspector.connect();
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    for (let batch = 0; batch < batches; batch++) {
      const retired: WeakRef<object>[] = [];
      const indices = Array.from(
        { length: active },
        (_, offset) => (batch * active + offset) % sessions,
      );
      const selected = new Set(indices.map(key));
      retired.push(...captureRows((row) => selected.has(row.key)));
      if (batch > 0) {
        retiredConfigs.push(new WeakRef(cfg));
      }
      cfg = config(batch + 1);
      if (values.allocation) {
        await startCollectedHeapSampling(inspector, 8192);
      }
      const started = performance.now(),
        cpu = process.threadCpuUsage();
      setRuntimeConfigSnapshot(cfg);
      const commitUsed = process.threadCpuUsage(cpu);
      const configCommit = {
        elapsedMs: performance.now() - started,
        cpuMs: (commitUsed.user + commitUsed.system) / 1000,
      };
      runOpenClawAgentWriteTransaction(
        (db) => {
          for (const index of indices) {
            writeSessionEntry(db, key(index), entry(index, batch + 1));
          }
          for (let index = 0; index < churn; index++) {
            const id = sessions + batch * churn + index;
            writeSessionEntry(db, key(id), entry(id, batch + 1));
          }
        },
        { agentId: "main" },
      );
      await projection.ensureMaterialized();
      describeCurrent(values["read-all"] ? allIndices : indices);
      await readPage();
      retired.push(...captureRows((row) => Number(row.key.split("-").at(-1)) >= sessions));
      runOpenClawAgentWriteTransaction(
        (db) => {
          for (let index = 0; index < churn; index++) {
            deleteSessionEntryRows(db, key(sessions + batch * churn + index), {
              deleteOwnedWindows: true,
            });
          }
        },
        { agentId: "main" },
      );
      await projection.ensureMaterialized();
      describeCurrent(values["read-all"] ? allIndices : indices);
      await readPage();
      const used = process.threadCpuUsage(cpu),
        elapsedMs = performance.now() - started;
      let allocatedBytes: number | undefined;
      if (values.allocation) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        allocatedBytes = sumSampledHeapBytes(profile.head);
        inspector.disconnect();
      }
      await collectForRetentionCheck(`batch-${batch}`);
      await expectCollected(...retired);
      assert.equal(countListeners(), listenerCount + 1);
      const checkpoint = {
        batch,
        configCommit,
        heapUsed: process.memoryUsage().heapUsed,
        retiredCollected: retired.length,
        retiredConfigsLive: retiredConfigs.filter((ref) => ref.deref()).length,
        elapsedMs,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes,
        ...inventory(),
        diagnostic: await readDiagnostic(sessions),
      };
      checkpoints.push(checkpoint);
      console.log(JSON.stringify(checkpoint));
    }
    if (values["cpu-profile"]) {
      const { profile } = await inspector.post("Profiler.stop");
      inspector.disconnect();
      writeFileSync(`${output}.cpuprofile`, JSON.stringify(profile));
    }
    await collectForRetentionCheck("settled");
    const settledHeap = process.memoryUsage().heapUsed;
    result.heapGrowth = settledHeap - warmHeap;
    result.final = inventory();
    if (values.snapshot) {
      result.snapshot = writeHeapSnapshot(`${output}.heapsnapshot`);
    }
    if (values["expect-config-collected"]) {
      await expectCollected(...retiredConfigs);
    }
    const retiredRows = captureRows(() => true);
    projection.dispose();
    await projection.ensureMaterialized();
    await collectForRetentionCheck("disposed");
    await expectCollected(...retiredRows, ...retiredConfigs);
    assert.equal(countListeners(), listenerCount);
    result.disposedRowsCollected = sessions;
    result.disposedReferencesCollected = retiredRows.length;
    const disposedHeap = process.memoryUsage().heapUsed;
    result.disposedHeap = disposedHeap;
    result.projectionReleasedHeap = settledHeap - disposedHeap;
    result.projectionReleasedHeapPerSession = (settledHeap - disposedHeap) / sessions;
    result.disposedDiagnostic = await readDiagnostic(0);
  } finally {
    projection.dispose();
    release();
    inspector.disconnect();
    stopDiagnostics();
  }
});
result.loadEnd = loadavg();
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
