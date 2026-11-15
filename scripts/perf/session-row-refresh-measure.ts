/**
 * Resident row refresh microbenchmark, not a Gateway/WebSocket load test.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-refresh-measure.ts \
 *   --state-dir .local/row-refresh/candidate --sessions 10000 --iterations 3000
 * Repeat with --allocation for a separate allocation pass; alternate baseline/candidate arms.
 * Run each revision in a separate process; output records hashes of both measured owners.
 * Each operation publishes an equivalent completed catalog, reads its prepared metadata,
 * then refreshes one resident row through an automation publication. Most stored rows are
 * archived; 64 resident rows and 40 plugin metadata records model the warm sidebar workload.
 * Accept byte-identical final rows and unchanged refresh counts with lower CPU/allocation.
 * Setup, warmup, digest construction, and cleanup are outside the measured interval.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "10000" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "Pass a new isolated --state-dir");
const root = path.resolve(values["state-dir"]);
mkdirSync(root, { mode: 0o700 });
process.env.TMPDIR = root;
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  label: "sessions",
  min: 64,
  fallback: 10000,
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 3000,
});
const sources = Object.fromEntries(
  ["session-row-projection", "session-row-projection-materialize"].map((name) => {
    const file = path.resolve("src/gateway", `${name}.ts`);
    return [name, createHash("sha256").update(readFileSync(file)).digest("hex")];
  }),
);
const [
  { withOpenClawTestState },
  { writeSessionEntry },
  { runOpenClawAgentWriteTransaction },
  { createSessionRowProjection },
  { retainSessionListForegroundWork },
  { createPreparedGatewayModelCatalog },
  { createPluginMetadataSnapshotFixture },
  { createEmptyPluginRegistry },
  { setActivePluginRegistry },
  { setCurrentPluginMetadataSnapshotState, clearCurrentPluginMetadataSnapshot },
  { setRuntimeConfigSnapshot },
  { notifyPreparedModelRuntimePublication },
  { sessionChanges },
  { getSessionRowSelectionMetrics },
] = await Promise.all([
  import("../../src/test-utils/openclaw-test-state.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/gateway/session-projection-work.js"),
  import("../../src/gateway/server-model-catalog-view.js"),
  import("../../src/plugins/plugin-metadata.test-support.js"),
  import("../../src/plugins/registry-empty.js"),
  import("../../src/plugins/runtime.js"),
  import("../../src/plugins/current-plugin-metadata-state.js"),
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/agents/prepared-model-runtime.publication-events.js"),
  import("../../src/sessions/session-row-changes.js"),
  import("../../src/infra/gateway-work-metrics.js"),
]);
const anchor = Date.UTC(2026, 9, 25);
const realNow = Date.now;
Date.now = () => anchor;
const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
try {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} }, defaults: { model: "fixture/model-0" } },
      plugins: { enabled: false },
    };
    setRuntimeConfigSnapshot(cfg);
    const pluginRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(pluginRegistry);
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: Array.from({ length: 40 }, (_, index) => ({ id: `fixture-${index}` })),
    });
    setCurrentPluginMetadataSnapshotState(
      metadataSnapshot,
      "row-refresh-measure",
      undefined,
      undefined,
      "gateway",
    );
    const entries = Array.from({ length: 32 }, (_, index) => ({
      provider: "fixture",
      id: `model-${index}`,
      name: `Model ${index}`,
      contextTokens: 32768,
    }));
    const catalog = new Map([
      [
        "main",
        createPreparedGatewayModelCatalog({
          config: cfg,
          entries,
          pluginRegistry,
          metadataSnapshot,
        }),
      ],
    ]);
    const key = (index: number) => `agent:main:row-refresh-${index}`;
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < sessions; index++) {
          writeSessionEntry(database, key(index), {
            sessionId: `row-refresh-${index}`,
            updatedAt: anchor - index,
            status: "done",
            visibility: "shared",
            label: `Synthetic row ${index}`,
            providerOverride: "fixture",
            modelOverride: `model-${index % entries.length}`,
            ...(index >= 64 ? { archivedAt: anchor - 1 } : {}),
          });
        }
      },
      { agentId: "main" },
    );
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      getModelCatalog: async () => catalog,
    });
    const inspector = new Session();
    try {
      await projection.prepareSelection();
      await projection.ensureMaterialized();
      const queries = Array.from({ length: 64 }, (_, index) => ({
        key: key(index),
        agentId: "main",
      }));
      await projection.withPreparedExactRows(
        () => queries,
        () => {},
      );
      let cacheReplacements = 0;
      async function run(count: number) {
        for (let index = 0; index < count; index++) {
          const previous = projection.state.rowContext.thinkingFactsByModelRef;
          notifyPreparedModelRuntimePublication({ phase: "published" });
          await projection.ensureMaterialized();
          if (projection.state.rowContext.thinkingFactsByModelRef !== previous) {
            cacheReplacements++;
          }
          const query = queries[index % queries.length]!;
          sessionChanges.emit({
            sessionKey: query.key,
            agentId: query.agentId,
            scope: "automation",
          });
          await projection.ensureMaterialized();
          assert(projection.describe(query));
        }
      }
      await run(128);
      cacheReplacements = 0;
      globalThis.gc?.();
      if (values.allocation) {
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const before = getSessionRowSelectionMetrics().materialization;
      const countBefore = projection.materializedCount;
      const memoryBefore = process.memoryUsage();
      const hostLoadBefore = loadavg();
      const cpu = process.threadCpuUsage();
      const start = performance.now();
      await run(iterations);
      const elapsedMs = performance.now() - start;
      const used = process.threadCpuUsage(cpu);
      const memoryAfter = process.memoryUsage();
      const after = getSessionRowSelectionMetrics().materialization;
      const allocatedBytes = values.allocation
        ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      const digest = createHash("sha256");
      for (const query of queries) {
        digest.update(JSON.stringify(projection.snapshot(query, { now: anchor }).row));
      }
      const result = {
        mode: values.allocation ? "allocation" : "timing",
        node: process.version,
        sessions,
        residentRows: queries.length,
        plugins: 40,
        iterations,
        sources,
        digest: digest.digest("hex"),
        cacheReplacements,
        refreshedRows: projection.materializedCount - countBefore,
        materialization: Object.fromEntries(
          (["created", "reused", "rebuilt", "skipped", "deepComparisons"] as const).map((name) => [
            name,
            after[name] - before[name],
          ]),
        ),
        elapsedMs,
        threadCpuMs: (used.user + used.system) / 1000,
        cpuUsPerOperation: (used.user + used.system) / iterations,
        allocatedBytes,
        allocatedBytesPerOperation:
          allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
        memoryBefore,
        memoryAfter,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
      };
      writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify(result));
    } finally {
      inspector.disconnect();
      projection.dispose();
      release();
      clearCurrentPluginMetadataSnapshot();
    }
  });
} finally {
  Date.now = realNow;
}
