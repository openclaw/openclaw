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
 * --mixed --sessions 5000 uses 500 resident rows and a deterministic mix of real writes,
 * no-op refreshes, fact reconciliation and archive demotion/re-promotion. --instrument
 * counts owner work in a separate process. --replica-base overlays the saved original
 * session-actor-replica.ts without swapping the checkout or dependency installation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
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
    mixed: { type: "boolean", default: false },
    instrument: { type: "boolean", default: false },
    "replica-base": { type: "string" },
    "cpu-profile": { type: "boolean", default: false },
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
// Mixed owner proof: 500 resident rows, real metadata/transcript writes, no-op refreshes,
// and archive demotion/re-promotion. Instrumentation is separate from timing/allocation.
const residentRows = values.mixed ? 500 : 64;
assert(sessions >= residentRows);
const work = { inputs: 0, modelRevisions: 0, captures: 0, replicaCandidates: 0, freezes: 0 };
Reflect.set(globalThis, "sessionRowRefreshWork", work);
const injections = new Map([
  [
    "src/gateway/session-utils-row.ts",
    ["  const { cfg, storePath, store, key, entry, agentId } = params;", "inputs"],
  ],
  [
    "src/gateway/session-model-revision.ts",
    ["  // Native bindings live outside the row;", "modelRevisions"],
  ],
  [
    "src/plugin-state/plugin-state-publication.ts",
    ["  const capture: PluginStateReadCapture = {", "captures"],
  ],
  [
    "src/config/sessions/session-actor-replica-receipts.ts",
    ["    const { database } = cell.target;", "replicaCandidates"],
  ],
  ["src/gateway/session-row-identity.ts", ["  for (const field of fields) {", "freezes"]],
]);
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith(new URL("../../", import.meta.url).href)
      ? url.slice(new URL("../../", import.meta.url).href.length)
      : undefined;
    const injection = relative && values.instrument ? injections.get(relative) : undefined;
    const baseline =
      relative === "src/config/sessions/session-actor-replica.ts" && values["replica-base"];
    if (!injection && !baseline) {
      return nextLoad(url, context);
    }
    let source = readFileSync(baseline || new URL(url), "utf8");
    if (injection) {
      const [needle, counter] = injection;
      assert(needle && source.includes(needle));
      source = source.replace(needle, `globalThis.sessionRowRefreshWork.${counter}++;\n${needle}`);
    }
    return { format: "module-typescript", source, shortCircuit: true };
  },
});
const sources = Object.fromEntries(
  [
    "gateway/session-row-projection",
    "gateway/session-row-projection-materialize",
    "config/sessions/session-actor-replica",
  ].map((name) => {
    const file =
      name.endsWith("/session-actor-replica") && values["replica-base"]
        ? values["replica-base"]
        : path.resolve("src", `${name}.ts`);
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
  { patchSessionEntryCore },
  { persistSessionTranscriptTurn },
  { readSessionActorRowFacts },
  { openOpenClawAgentDatabase },
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
  import("../../src/config/sessions/session-accessor.sqlite-entry.js"),
  import("../../src/config/sessions/session-accessor.transcript-turn.js"),
  import("../../src/config/sessions/session-actor-replica.js"),
  import("../../src/state/openclaw-agent-db.js"),
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
            toolOverrides: { mcpToolsDeny: { synthetic: ["unchanged"] } },
            ...(index >= residentRows ? { archivedAt: anchor - 1 } : {}),
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
      const queries = Array.from({ length: residentRows }, (_, index) => ({
        key: key(index),
        agentId: "main",
      }));
      await projection.withPreparedExactRows(
        () => queries,
        () => {},
      );
      let cacheReplacements = 0;
      let sequence = 0;
      const durations: number[] = [];
      const outcomes: Record<
        string,
        Record<"events" | "created" | "rebuilt" | "reused" | "skipped", number> &
          Partial<typeof work>
      > = {};
      const databasePath = openOpenClawAgentDatabase({ agentId: "main" }).path;
      async function run(count: number) {
        for (let index = 0; index < count; index++) {
          if (values.mixed) {
            const turn = sequence++;
            const rowIndex = (turn * 37 + Math.floor(turn / queries.length)) % queries.length;
            const query = queries[rowIndex]!;
            const target = { agentId: query.agentId, sessionKey: query.key };
            const event = turn % 20;
            const kind =
              event < 10
                ? "no-op"
                : event < 14
                  ? "metadata"
                  : event < 18
                    ? "transcript"
                    : event === 18
                      ? "reconcile"
                      : "archive";
            const before = getSessionRowSelectionMetrics().materialization;
            const workBefore = values.instrument ? { ...work } : undefined;
            const at = performance.now();
            if (kind === "no-op") {
              sessionChanges.emit({ ...target, scope: "automation" });
            } else if (kind === "reconcile") {
              sessionChanges.emit({ ...target, scope: "session-entry", factsInvalidated: true });
            } else if (kind === "metadata") {
              await patchSessionEntryCore(target, () => ({ label: `Synthetic patch ${turn}` }), {
                skipMaintenance: true,
              });
            } else if (kind === "transcript") {
              await persistSessionTranscriptTurn(
                { ...target, sessionId: `row-refresh-${rowIndex}` },
                {
                  touchSessionEntry: false,
                  messages: [
                    {
                      message: {
                        role: "assistant",
                        content: `Synthetic append ${turn}`,
                        timestamp: anchor + turn,
                      },
                    },
                  ],
                },
              );
            } else {
              await patchSessionEntryCore(target, () => ({ archivedAt: anchor }), {
                skipMaintenance: true,
              });
              await projection.ensureMaterialized();
              await patchSessionEntryCore(target, () => ({ archivedAt: undefined }), {
                skipMaintenance: true,
              });
            }
            await projection.ensureMaterialized();
            await projection.withPreparedExactRows(
              () => [query],
              (read) => {
                assert(read.describe(query));
              },
            );
            durations.push(performance.now() - at);
            const after = getSessionRowSelectionMetrics().materialization;
            const counts = (outcomes[kind] ??= {
              events: 0,
              created: 0,
              rebuilt: 0,
              reused: 0,
              skipped: 0,
            });
            counts.events++;
            for (const name of ["created", "rebuilt", "reused", "skipped"] as const) {
              counts[name] += after[name] - before[name];
            }
            if (workBefore) {
              for (const name of Object.keys(work) as (keyof typeof work)[]) {
                counts[name] = (counts[name] ?? 0) + work[name] - workBefore[name];
              }
            }
            continue;
          }
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
      durations.length = 0;
      for (const kind of Object.keys(outcomes)) {
        delete outcomes[kind];
      }
      for (const counter of Object.keys(work) as (keyof typeof work)[]) {
        work[counter] = 0;
      }
      globalThis.gc?.();
      if (values.allocation || values["cpu-profile"]) {
        inspector.connect();
      }
      if (values.allocation) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      if (values["cpu-profile"]) {
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.start");
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
      if (values["cpu-profile"]) {
        writeFileSync(
          path.join(root, "owner.cpuprofile"),
          JSON.stringify((await inspector.post("Profiler.stop")).profile),
        );
      }
      const digest = createHash("sha256");
      for (const query of queries) {
        digest.update(JSON.stringify(projection.snapshot(query, { now: anchor }).row));
      }
      const measuredWork = { ...work };
      // Separate hot/missing replica reads: the bounded replica pool is smaller than the roster.
      // This excludes projection writes, worker I/O, and observer bookkeeping from lookup cost.
      let replicaHits = 0;
      if (values.allocation) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const replicaBefore = work.replicaCandidates;
      const replicaCpu = process.threadCpuUsage();
      const replicaStart = performance.now();
      for (let pass = 0; pass < 20; pass++) {
        for (const query of queries) {
          if (readSessionActorRowFacts({ path: databasePath, sessionKey: query.key })) {
            replicaHits++;
          }
        }
      }
      const replicaElapsed = performance.now() - replicaStart;
      const replicaUsed = process.threadCpuUsage(replicaCpu);
      const replicaBytes = values.allocation
        ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      durations.sort((a, b) => a - b);
      const result = {
        mode: values.allocation ? "allocation" : "timing",
        node: process.version,
        sessions,
        residentRows: queries.length,
        mixed: values.mixed,
        instrumented: values.instrument,
        work: values.instrument ? measuredWork : undefined,
        outcomes,
        medianEventMs: durations[Math.floor(durations.length / 2)],
        p95EventMs: durations[Math.ceil(durations.length * 0.95) - 1],
        replica: {
          reads: 20 * queries.length,
          hits: replicaHits,
          candidates: values.instrument ? work.replicaCandidates - replicaBefore : undefined,
          elapsedMs: replicaElapsed,
          cpuMs: (replicaUsed.user + replicaUsed.system) / 1000,
          allocatedBytes: replicaBytes,
        },
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
