/**
 * Session-summary owner microbenchmark: 10,000 synthetic resident entries, followed
 * by mutations and reads of every physical store. No Gateway/SQLite costs.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-store-summary-measure.ts \
 *   --iterations 3000 --stores 1 --create-burst 8
 * Save baseline session-stores.ts before editing and pass --owner /absolute/base.ts.
 * Alternate base/candidate order; repeat with --allocations in separate processes.
 * Omit --create-burst for row replacements; --warm covers idle reads. Creation
 * warmup only reads, so 3,000 eight-row bursts grow exactly 10,000 to 34,000 rows.
 * --cold measures only the first fleet read (one iteration, no warmup/mutation);
 * use with --allocations for separate cold preparation allocation measurements.
 * Post-GC heap deltas include both retained owner state and synthetic fixture growth;
 * compare the same workload across arms. Forced GC and oracles stay outside timing.
 * The loader exposes the private owner function only in this measurement process.
 * Compare identical output checksums and counts, lower CPU/allocation, and host load.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "3000" },
    stores: { type: "string", default: "40" },
    allocations: { type: "boolean", default: false },
    warm: { type: "boolean", default: false },
    cold: { type: "boolean", default: false },
    "create-burst": { type: "string", default: "0" },
  },
});
assert(global.gc, "Run with --expose-gc");
const integer = (name: "iterations" | "stores", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback });
const iterations = values.cold ? 1 : integer("iterations", 3000);
const storeCount = integer("stores", 40);
const createBurst = parseStrictIntegerOption({
  raw: values["create-burst"],
  label: "--create-burst",
  min: 0,
  fallback: 0,
});
assert(!values.warm || createBurst === 0, "--warm cannot create rows");
assert(!values.cold || (!values.warm && createBurst === 0), "--cold measures preparation only");
const sessionCount = 10000;
assert(storeCount <= sessionCount);
const ownerUrl = new URL("../../src/status/session-stores.ts", import.meta.url).href;
const sourceUrl = values.owner ? pathToFileURL(path.resolve(values.owner)).href : ownerUrl;
const source = readFileSync(new URL(sourceUrl), "utf8");
let instrumented = false;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl) {
      return nextLoad(url, context);
    }
    instrumented = true;
    return {
      format: "module",
      source: `${stripTypeScriptTypes(source)}\nexport { summarizeProjectionRows };\n`,
      shortCircuit: true,
    };
  },
});

type Row = {
  key: string;
  agentId: string;
  storeTarget: { storePath: string };
  entry: SessionEntry;
};
type Recent = { sessionKey: string; entry: SessionEntry };
type Summary = {
  count: number;
  recent: Recent[];
  byAgent: Map<string, { count: number; recent: Recent[] }>;
};
type Change = { kind: "row"; id: string; key: string; agentId: string; row: Row };
const listeners = new Set<(change: Change) => void>();
const stores: Array<{ path: string; rows: Row[] }> = Array.from(
  { length: storeCount },
  (_, index) => ({
    path: `/synthetic/store-${index}.sqlite`,
    rows: [],
  }),
);
for (let index = 0; index < sessionCount; index++) {
  const store = stores[index % storeCount]!;
  const agentId = `agent-${index % storeCount}`;
  store.rows.push({
    key: `agent:${agentId}:session-${String(index).padStart(5, "0")}`,
    agentId,
    storeTarget: { storePath: store.path },
    entry: { sessionId: `session-${index}`, updatedAt: (index * 7919) % sessionCount },
  });
}
const rowsByPath = new Map(stores.map((store) => [store.path, store.rows]));
let selectedRows = 0;
let selectionCalls = 0;
const projection = {
  state: { revision: {} },
  onSelectionChange(listener: (change: Change) => void) {
    listeners.add(listener);
  },
  selectEntries({ storePath }: { storePath: string }) {
    const rows = rowsByPath.get(storePath)!;
    selectionCalls++;
    selectedRows += rows.length;
    return rows.slice();
  },
};
const {
  summarizeProjectionRows,
}: {
  summarizeProjectionRows: (owner: typeof projection, storePath: string, limit: number) => Summary;
} = await import(ownerUrl);
assert(instrumented, "Owner instrumentation was not loaded");
let sequence = 0;
let nextSession = sessionCount;
function publish(row: Row) {
  projection.state.revision = {};
  const change: Change = {
    kind: "row",
    id: `${row.agentId}\0${row.storeTarget.storePath}\0${row.key}`,
    key: row.key,
    agentId: row.agentId,
    row,
  };
  for (const listener of listeners) {
    listener(change);
  }
}
function run(count: number, mutate = !values.warm && !values.cold) {
  let checksum = 0;
  for (let index = 0; index < count; index++, sequence++) {
    if (mutate) {
      const store = stores[sequence % storeCount]!;
      if (createBurst > 0) {
        const agentId = store.rows[0]!.agentId;
        for (let added = 0; added < createBurst; added++, nextSession++) {
          const row: Row = {
            key: `agent:${agentId}:session-${String(nextSession).padStart(5, "0")}`,
            agentId,
            storeTarget: { storePath: store.path },
            entry: { sessionId: `session-${nextSession}`, updatedAt: sessionCount + sequence },
          };
          store.rows.push(row);
          publish(row);
        }
      } else {
        const rowIndex = Math.floor(sequence / storeCount) % store.rows.length;
        const previous = store.rows[rowIndex]!;
        const row = {
          ...previous,
          entry: { ...previous.entry, updatedAt: sessionCount + sequence },
        };
        store.rows[rowIndex] = row;
        publish(row);
      }
    }
    for (const store of stores) {
      const summary = summarizeProjectionRows(projection, store.path, 10);
      checksum += summary.count;
      for (const agent of summary.byAgent.values()) {
        checksum += agent.recent[0]?.entry.updatedAt ?? 0;
      }
    }
  }
  return checksum;
}
const encodeSummary = (summary: Summary) =>
  JSON.stringify({ ...summary, byAgent: [...summary.byAgent] });
const inspector = new Session();
try {
  const warmup = values.cold ? 0 : 100;
  run(warmup, !values.warm && createBurst === 0);
  const snapshots = values.cold
    ? []
    : stores.map((store) => {
        const summary = summarizeProjectionRows(projection, store.path, 10);
        return { summary, encoded: encodeSummary(summary) };
      });
  global.gc();
  const retainedMemoryBefore = process.memoryUsage();
  selectionCalls = 0;
  selectedRows = 0;
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  const checksum = run(iterations);
  const wallMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const counts = { selectionCalls, selectedRows };
  const allocatedBytes = values.allocations
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  global.gc();
  const retainedMemoryAfter = process.memoryUsage();
  for (const snapshot of snapshots) {
    assert.equal(encodeSummary(snapshot.summary), snapshot.encoded, "Read snapshot was mutated");
  }
  const output = stores.map((store) => {
    const summary = summarizeProjectionRows(projection, store.path, 10);
    const expected = store.rows
      .toSorted(
        (left, right) =>
          right.entry.updatedAt - left.entry.updatedAt ||
          (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
      )
      .slice(0, 10)
      .map((row) => ({ sessionKey: row.key, entry: row.entry }));
    assert.equal(summary.count, store.rows.length);
    assert.deepEqual(summary.recent, []);
    assert.deepEqual(
      summary.byAgent,
      new Map([[store.rows[0]!.agentId, { count: store.rows.length, recent: expected }]]),
    );
    return { path: store.path, count: summary.count, recent: expected };
  });
  console.log(
    JSON.stringify({
      scope: "summary owner; synthetic resident projection; no Gateway or SQLite",
      mode: values.allocations ? "allocation" : "timing",
      workload: values.cold
        ? "cold-first-fleet-read"
        : values.warm
          ? "idle"
          : createBurst > 0
            ? "creation-burst-per-fleet-read"
            : "one-row-replacement-per-fleet-read",
      owner: sourceUrl,
      ownerSha256: createHash("sha256").update(source).digest("hex"),
      node: process.version,
      sessionCount,
      finalSessionCount: nextSession,
      createdRows: nextSession - sessionCount,
      createBurst,
      storeCount,
      iterations,
      warmup,
      checksum,
      outputSha256: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
      ...counts,
      cpuMs: (used.user + used.system) / 1000,
      wallMs,
      allocatedBytes,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
      retainedMemoryBefore,
      retainedMemoryAfter,
      retainedHeapDeltaBytes: retainedMemoryAfter.heapUsed - retainedMemoryBefore.heapUsed,
    }),
  );
} finally {
  inspector.disconnect();
}
