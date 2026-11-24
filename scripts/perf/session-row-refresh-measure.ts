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
 * --changed uses three agents and replaces no-op events with changed-row events.
 * --owner also replays 10,000 metadata changes through captured real row inputs.
 * --source-base overlays the changed owner modules saved by basename from the
 * baseline revision. It leaves the benchmark and dependency installation identical.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { compileFunction } from "node:vm";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "10000" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
    mixed: { type: "boolean", default: false },
    changed: { type: "boolean", default: false },
    owner: { type: "boolean", default: false },
    "source-base": { type: "string" },
    instrument: { type: "boolean", default: false },
    "replica-base": { type: "string" },
    "cpu-profile": { type: "boolean", default: false },
    "freeze-fixture": { type: "string" },
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
const residentRows = values.mixed || values.changed ? 500 : 64;
const agentIds = values.changed ? ["main", "research", "ops"] : ["main"];
const agentFor = (index: number) => agentIds[index % agentIds.length]!;
const changedSources = [
  "src/agents/agent-scope-config.ts",
  "src/agents/agent-roster.ts",
  "src/agents/fast-mode.ts",
  "src/agents/sandbox/runtime-status.ts",
  "src/gateway/session-utils-row.ts",
  "src/gateway/session-row-identity.ts",
  "src/gateway/session-row-presentation.ts",
];
assert(sessions >= residentRows);
const work = {
  inputs: 0,
  modelRevisions: 0,
  captures: 0,
  replicaCandidates: 0,
  freezes: 0,
  agentConfigs: 0,
};
Reflect.set(globalThis, "sessionRowRefreshWork", work);
type RowParams = Parameters<
  typeof import("../../src/gateway/session-utils-row.js").readSessionRowInputs
>[0];
const ownerInputs = new Map<string, RowParams>();
Reflect.set(globalThis, "sessionRowOwnerInputs", ownerInputs);
const freezeShapes: object[] = [];
if (values["freeze-fixture"]) {
  // Separate diagnostic process: captures real producer rows before any cleanup.
  const fast = compileFunction("return %HasFastProperties(row)", ["row"]);
  const sameMap = compileFunction("return %HaveSameMap(a, b)", ["a", "b"]);
  const shapes = new Map<string, (frozen: object) => void>();
  Reflect.set(
    globalThis,
    "captureSessionRowFreeze",
    (row: Record<string, unknown>, fields?: string[]) => {
      const keys = Object.keys(row);
      const patch = fields !== undefined;
      const shape = `${patch ? "patch" : "row"}\n${keys.join("\n")}`;
      const existing = shapes.get(shape);
      if (existing) {
        return existing;
      }
      if (shapes.size >= 12) {
        return undefined;
      }
      const sample = {
        patch,
        fields,
        beforeFast: fast(row),
        afterFast: false,
        rows: 0,
        fastRows: 0,
        sharedMaps: 0,
        entries: keys.map((key) => ({ key, defined: row[key] !== undefined, value: row[key] })),
      };
      freezeShapes.push(sample);
      let previous: object | undefined;
      const capture = (frozen: object) => {
        sample.afterFast = fast(frozen);
        sample.rows++;
        sample.fastRows += Number(sample.afterFast);
        sample.sharedMaps += Number(previous !== undefined && sameMap(previous, frozen));
        previous = frozen;
      };
      shapes.set(shape, capture);
      return capture;
    },
  );
}
const injections = new Map([
  [
    "src/agents/agent-scope-config.ts",
    ["  const agentDefaults = cfg.agents?.defaults;", "agentConfigs"],
  ],
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
      (relative === "src/config/sessions/session-actor-replica.ts" && values["replica-base"]) ||
      (relative && values["source-base"] && changedSources.includes(relative)
        ? path.join(values["source-base"], path.basename(relative))
        : undefined);
    const captureOwner = values.owner && relative === "src/gateway/session-utils-row.ts";
    const captureFreeze =
      values["freeze-fixture"] && relative === "src/gateway/session-row-identity.ts";
    if (
      !injection &&
      !baseline &&
      !captureOwner &&
      !captureFreeze &&
      !(values.changed && relative && changedSources.includes(relative))
    ) {
      return nextLoad(url, context);
    }
    let source = readFileSync(baseline || new URL(url), "utf8");
    if (captureFreeze) {
      source = source.replace(
        "export function freezeSessionRow(",
        "function freezeSessionRowCaptured(",
      );
      source += `
export function freezeSessionRow(...args: Parameters<typeof freezeSessionRowCaptured>) {
  const capture = globalThis.captureSessionRowFreeze(args[0], args[2]);
  const row = freezeSessionRowCaptured(...args);
  capture?.(row);
  return row;
}`;
    }
    if (captureOwner) {
      source = source.replace(
        "export function readSessionRowInputs(",
        "function readSessionRowInputsCaptured(",
      );
      source += `
export function readSessionRowInputs(...args: Parameters<typeof readSessionRowInputsCaptured>) {
        globalThis.sessionRowOwnerInputs?.set(args[0].key, args[0]);
        return readSessionRowInputsCaptured(...args);
      }`;
    }
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
    ...changedSources.map((file) => file.slice(4, -3)),
  ].map((name) => {
    const file =
      name.endsWith("/session-actor-replica") && values["replica-base"]
        ? values["replica-base"]
        : values["source-base"] && changedSources.includes(`src/${name}.ts`)
          ? path.join(values["source-base"], path.basename(`${name}.ts`))
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
function freezeNativeBytes(node: HeapProfiler.SamplingHeapProfileNode, freezing = false): number {
  const inFreeze = freezing || node.callFrame.functionName === "freezeSessionRow";
  return (
    (inFreeze && node.callFrame.scriptId === "0" ? node.selfSize : 0) +
    node.children.reduce((sum, child) => sum + freezeNativeBytes(child, inFreeze), 0)
  );
}
const sampledAllocation = (node: HeapProfiler.SamplingHeapProfileNode) => ({
  allocatedBytes: sampledBytes(node),
  freezeNativeBytes: freezeNativeBytes(node),
});
try {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: Object.fromEntries(
          agentIds.map((id, index) => [
            id,
            values.changed
              ? {
                  workspace: path.join(root, "workspace", id),
                  reasoningDefault: index === 1 ? "on" : "off",
                  fastModeDefault: index === 2,
                  sandbox: { mode: index === 1 ? "non-main" : "off" },
                }
              : {},
          ]),
        ),
        defaults: { model: "fixture/model-0" },
      },
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
    const catalog = new Map(
      agentIds.map((agentId) => [
        agentId,
        createPreparedGatewayModelCatalog({
          config: cfg,
          entries,
          pluginRegistry,
          metadataSnapshot,
        }),
      ]),
    );
    const key = (index: number) => `agent:${agentFor(index)}:row-refresh-${index}`;
    for (const agentId of agentIds) {
      runOpenClawAgentWriteTransaction(
        (database) => {
          for (let index = 0; index < sessions; index++) {
            if (agentFor(index) !== agentId) {
              continue;
            }
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
        { agentId },
      );
    }
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
        agentId: agentFor(index),
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
      const databasePaths = new Map(
        agentIds.map((agentId) => [agentId, openOpenClawAgentDatabase({ agentId }).path]),
      );
      async function run(count: number) {
        for (let index = 0; index < count; index++) {
          if (values.mixed || values.changed) {
            const turn = sequence++;
            const rowIndex = (turn * 37 + Math.floor(turn / queries.length)) % queries.length;
            const query = queries[rowIndex]!;
            const target = { agentId: query.agentId, sessionKey: query.key };
            const event = values.changed ? 10 + (turn % 10) : turn % 20;
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
      const allocation = values.allocation
        ? sampledAllocation((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      const allocatedBytes = allocation?.allocatedBytes;
      if (values["cpu-profile"]) {
        writeFileSync(
          path.join(root, "owner.cpuprofile"),
          JSON.stringify((await inspector.post("Profiler.stop")).profile),
        );
      }
      const digest = createHash("sha256");
      const rowDigest = createHash("sha256");
      for (const query of queries) {
        digest.update(JSON.stringify(projection.snapshot(query, { now: anchor }).row));
        rowDigest.update(JSON.stringify(projection.describe(query)!.materialized.row));
      }
      const measuredWork = { ...work };
      let ownerResult;
      if (values.owner) {
        const { readSessionRowInputs, materializeSessionRow } =
          await import("../../src/gateway/session-utils-row.js");
        Reflect.set(globalThis, "sessionRowOwnerInputs", undefined);
        const inputs = queries.map((query) => {
          const params = ownerInputs.get(query.key);
          assert(params, `Missing resident input ${query.key}`);
          return params;
        });
        const rows = inputs.map((params) =>
          materializeSessionRow(readSessionRowInputs(params).inputs),
        );
        const ownerDurations: number[] = [];
        const replay = (count: number) => {
          for (let index = 0; index < count; index++) {
            const slot = index % inputs.length;
            const params = inputs[slot]!;
            const at = performance.now();
            rows[slot] = materializeSessionRow(
              readSessionRowInputs({
                ...params,
                entry: { ...params.entry!, label: `Synthetic owner patch ${index}` },
              }).inputs,
              rows[slot],
            );
            ownerDurations.push(performance.now() - at);
          }
        };
        replay(2000);
        ownerDurations.length = 0;
        globalThis.gc?.();
        if (values.allocation) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const ownerCpu = process.threadCpuUsage();
        const ownerStart = performance.now();
        replay(10000);
        const ownerElapsed = performance.now() - ownerStart;
        const ownerUsed = process.threadCpuUsage(ownerCpu);
        const ownerAllocation = values.allocation
          ? sampledAllocation((await inspector.post("HeapProfiler.stopSampling")).profile.head)
          : undefined;
        ownerDurations.sort((a, b) => a - b);
        const ownerDigest = createHash("sha256");
        for (const row of rows) {
          ownerDigest.update(JSON.stringify(row.row));
        }
        ownerResult = {
          iterations: 10000,
          cpuMs: (ownerUsed.user + ownerUsed.system) / 1000,
          elapsedMs: ownerElapsed,
          ...ownerAllocation,
          medianMs: ownerDurations[5000],
          p95Ms: ownerDurations[9499],
          digest: ownerDigest.digest("hex"),
        };
      }
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
          if (
            readSessionActorRowFacts({
              path: databasePaths.get(query.agentId)!,
              sessionKey: query.key,
            })
          ) {
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
        changed: values.changed,
        agents: agentIds.length,
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
        owner: ownerResult,
        plugins: 40,
        iterations,
        sources,
        digest: digest.digest("hex"),
        rowDigest: rowDigest.digest("hex"),
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
        freezeNativeBytes: allocation?.freezeNativeBytes,
        allocatedBytesPerOperation:
          allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
        memoryBefore,
        memoryAfter,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
      };
      writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
      if (values["freeze-fixture"]) {
        writeFileSync(values["freeze-fixture"], `${JSON.stringify(freezeShapes, null, 2)}\n`);
      }
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
