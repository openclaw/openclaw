/**
 * Selection publication owner benchmark; no Gateway/transport latency claim.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-selection-facts-measure.ts \
 *   --iterations 5000 --sessions 10800 --listeners 20 --mode timing
 * Repeat in a fresh process with --mode allocation. Run baseline/candidate in AB/BA order.
 * --source and --record-source accept pinned session-row-selection.ts and
 * session-row-projection-record.ts copies beside their originals, retaining relative
 * imports. Pin BOTH: selectionRow owns fact preparation, and change consumes it.
 * Construction/warmup is excluded. Each update prepares one owner snapshot and fans it
 * out through the real listener dispatcher. Cases repeat identical publication, change
 * only presentation metadata, and change filter metadata without changing updatedAt.
 * Acceptance: identical result digests and lower CPU/allocation without an adverse
 * metadata-update result. Allocation includes collected objects in a separate pass;
 * GC/timing decisions use only the untraced timing pass.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import {
  performance,
  PerformanceObserver,
  type PerformanceEntry,
  type PerformanceNodeEntry,
} from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildSubagentSessionListReadIndex } from "../../src/agents/subagents/registry/subagent-registry-read.js";
import { readSessionListSelectionFacts } from "../../src/gateway/session-list-target.js";
import type { Row, SelectionChange } from "../../src/gateway/session-row-projection-record.js";
import { buildSessionListRowMetadataContext } from "../../src/gateway/session-utils-projection.js";
import { notifyListeners } from "../../src/shared/listeners.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "src/gateway/session-row-selection.ts" },
    "record-source": { type: "string", default: "src/gateway/session-row-projection-record.ts" },
    iterations: { type: "string", default: "5000" },
    sessions: { type: "string", default: "10800" },
    listeners: { type: "string", default: "20" },
    mode: { type: "string", default: "timing" },
  },
});
assert(global.gc, "run with --expose-gc");
assert(values.mode === "timing" || values.mode === "allocation");
const integer = (name: "iterations" | "sessions" | "listeners") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const sessions = integer("sessions");
const listenerCount = integer("listeners");
const source = path.resolve(values.source);
const recordSource = path.resolve(values["record-source"]);
const { createSessionRowSelection }: typeof import("../../src/gateway/session-row-selection.js") =
  await import(pathToFileURL(source).href);
const records: typeof import("../../src/gateway/session-row-projection-record.js") = await import(
  pathToFileURL(recordSource).href
);
const now = Date.UTC(2026, 9, 27);
const cfg = { agents: { entries: { main: {}, ops: {} } } };
const agents = new Set(["main", "ops"]);
const storePath = "/synthetic/selection-facts-measure.sqlite";
const context = buildSessionListRowMetadataContext({
  now,
  subagentRuns: buildSubagentSessionListReadIndex(now, [], new Map()),
});
const scope = {
  agentId: undefined,
  path: storePath,
  paths: new Map([[storePath, 0]]),
  configuredAgentIds: agents,
  ownerAgentIds: agents,
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
const results = [];
for (const name of ["unchanged", "presentation", "metadata"] as const) {
  const owners = Array.from({ length: listenerCount }, () =>
    createSessionRowSelection(cfg, scope, false, () => context),
  );
  const listeners = new Set(
    owners.map(
      (owner) => (change: Exclude<SelectionChange, { kind: "reset" }>) => owner.change(change),
    ),
  );
  const rows: Row[] = Array.from({ length: sessions }, (_, index) => {
    const agentId = index % 3 ? "main" : "ops";
    const key = `agent:${agentId}:${index % 5 ? "subagent" : "dashboard"}:fixture-${index}`;
    const entry = {
      sessionId: `fixture-${index}`,
      updatedAt: now - index * 1000,
      lastActivityAt: now - index * 1000,
      lastInteractionAt: now - index * 1000,
      lifecycleRevision: "fixture-generation",
      label: `Synthetic session ${index}`,
      modelProvider: "synthetic",
      model: "mock-model",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      createdActor: { type: "human" as const, source: "profile" as const, id: "synthetic" },
      ...(index % 5 ? { parentSessionKey: `agent:${agentId}:dashboard:fixture-0` } : {}),
      ...(index % 7 === 0 ? { archivedAt: now - 1000 } : {}),
    };
    const row = {
      ...records.create({ key, agentId, storeTarget: { agentId, storePath } }, entry),
      entry,
      hasBoard: false,
    };
    const selected = records.selectionRow(row)!;
    for (const owner of owners) {
      owner.add(selected);
    }
    return row;
  });
  for (const owner of owners) {
    owner.read();
  }
  let revision = 0;
  const run = () => {
    const index = revision++ % sessions;
    let row = rows[index]!;
    if (name !== "unchanged") {
      const entry = {
        ...row.entry!,
        ...(name === "presentation"
          ? { outputTokens: revision }
          : { label: `Changed ${revision}` }),
      };
      row = {
        ...row,
        entry,
        selection: readSessionListSelectionFacts(row.key, entry),
      };
      rows[index] = row;
    }
    const change: Exclude<SelectionChange, { kind: "reset" }> = {
      kind: "row",
      id: records.identity(row),
      key: row.key,
      agentId: row.agentId,
      row: records.selectionRow(row),
    };
    notifyListeners(listeners, change, (error) => {
      throw error;
    });
  };
  for (let index = 0; index < 500; index++) {
    run();
  }
  global.gc();
  await nextTurn();
  const inspector = new Session();
  const collections: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => collections.push(...list.getEntries()));
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const times = new Float64Array(iterations);
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    run();
    times[index] = performance.now() - before;
  }
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const hostLoadAfter = loadavg();
  let bytes: number | undefined;
  if (values.mode === "allocation") {
    bytes = sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head);
    inspector.disconnect();
  } else {
    await nextTurn();
    await nextTurn();
    collections.push(...observer.takeRecords());
    observer.disconnect();
  }
  const expected = digest(rows.map((row) => [row.key, row.entry]));
  for (const owner of owners) {
    assert.equal(digest(owner.read().entries("all")), expected, `${name}: stale published entry`);
  }
  times.sort();
  const gcMs = collections.reduce((sum, entry) => sum + entry.duration, 0);
  const gcByKind: Record<number, { count: number; ms: number; maxMs: number }> = {};
  for (const entry of collections) {
    const { kind } = (entry as PerformanceNodeEntry).detail as { kind: number };
    const group = (gcByKind[kind] ??= { count: 0, ms: 0, maxMs: 0 });
    group.count++;
    group.ms += entry.duration;
    group.maxMs = Math.max(group.maxMs, entry.duration);
  }
  results.push({
    name,
    iterations,
    hostLoadBefore,
    hostLoadAfter,
    elapsedMs,
    mainThreadCpuMs: (used.user + used.system) / 1000,
    mainThreadCpuUsPerUpdate: (used.user + used.system) / iterations,
    sampledBytesPerUpdate: bytes === undefined ? undefined : bytes / iterations,
    p50Ms: times[Math.floor(iterations * 0.5)],
    p99Ms: times[Math.min(iterations - 1, Math.floor(iterations * 0.99))],
    gcMs,
    gcMsPerUpdate: gcMs / iterations,
    gcMsPerMinute: (gcMs * 60_000) / elapsedMs,
    gcCount: collections.length,
    gcByKind,
    gcMaxMs: Math.max(0, ...collections.map((entry) => entry.duration)),
    memoryBefore,
    memoryAfter,
    digest: expected,
  });
}
console.log(
  JSON.stringify({
    node: process.version,
    source,
    sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
    recordSource,
    recordSourceSha256: createHash("sha256").update(readFileSync(recordSource)).digest("hex"),
    sessions,
    listenerCount,
    mode: values.mode,
    results,
  }),
);
