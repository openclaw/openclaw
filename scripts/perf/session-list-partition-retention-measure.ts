/**
 * Session-list partition lifetime CPU/allocation proof; no Gateway or database.
 *
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/session-list-partition-retention-measure.ts \
 *   --mode cpu --iterations 3000 --output .local/partition-cpu.json
 * Repeat with --mode allocation. Run the identical script on base/candidate in
 * AB/BA order; compare untraced CPU and separate 16 KiB allocation samples.
 *
 * Fixture: 10,000 sessions, the real selection owner's 64 partitions, four fixed
 * query windows, and one sidebar baseline. Each iteration updates one partition
 * and reads every query. Initial population is excluded. A fresh final cache
 * reports the same live work without historical accounting; final selection JSON
 * must match uncached reads and its digest must match between revisions.
 * Acceptance: no phantom growth/avoidable baseline loss, identical selections,
 * and no controlled adverse CPU/allocation regression. This
 * measures owner work, not network/serialization/rendering or production rates.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { buildSubagentSessionListReadIndex } from "../../src/agents/subagents/registry/subagent-registry-read.js";
import { SessionListViewCache } from "../../src/gateway/session-list-view-cache.js";
import {
  create,
  identity,
  selectionRow,
  type EntryRow,
} from "../../src/gateway/session-row-projection-record.js";
import { createSessionRowSelection } from "../../src/gateway/session-row-selection.js";
import { selectSessionEntries } from "../../src/gateway/session-utils-list.js";
import { buildSessionListRowMetadataContext } from "../../src/gateway/session-utils-projection.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../src/infra/diagnostic-events.js";
import { getSessionRowSelectionMetrics } from "../../src/infra/gateway-work-metrics.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "cpu" },
    iterations: { type: "string", default: "3000" },
    output: { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(values.mode === "cpu" || values.mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
const now = 1_800_000_000_000;
const cfg = { agents: { entries: { main: {} } } };
const agents = new Set(["main"]);
const storePath = "/synthetic/partition-retention.sqlite";
const context = buildSessionListRowMetadataContext({
  now,
  subagentRuns: buildSubagentSessionListReadIndex(now, [], new Map()),
});
const selection = createSessionRowSelection(
  cfg,
  {
    agentId: "main",
    path: storePath,
    paths: new Map([[storePath, 0]]),
    configuredAgentIds: agents,
    ownerAgentIds: agents,
  },
  false,
  () => context,
);
const rows = new Map<string, EntryRow>();
for (let index = 0; index < 10_000; index++) {
  const key = `agent:main:retention-${index}`;
  const entry = { sessionId: String(index), updatedAt: now + index };
  const row: EntryRow = {
    ...create({ key, agentId: "main", storeTarget: { agentId: "main", storePath } }, entry),
    entry,
  };
  rows.set(key, row);
  selection.add(selectionRow(row)!);
}
const partitions = selection.read().partitions!;
const keys = partitions.map((partition) => partition.entries.keys().next().value!);
const queries = [100, 150, 200, 250].map((limit) => ({ limit, archived: "all" as const }));
const cache = new SessionListViewCache();
const sidebar = [{ key: "retained-sidebar", kind: "direct" as const, updatedAt: now }];
const read = (opts: (typeof queries)[number], owner?: SessionListViewCache) => {
  const view = owner?.get(String(opts.limit));
  const selected = selection.read("updatedAt");
  const result = selectSessionEntries({
    cfg,
    opts,
    now,
    entries: selected.entries,
    entriesSorted: true,
    partitions: selected.partitions,
    retained: owner && view ? owner.partitions(view) : undefined,
    getTarget: selected.get,
    involvementKeys: selected.involvementKeys,
    configuredAgentIds: selected.configuredAgentIds,
    getRowContext: () => context,
  });
  if (owner && view) {
    view.selection = result;
    owner.update(view);
  }
  return result;
};
const cacheBytes = (owner: SessionListViewCache) =>
  Array.from(owner.values()).reduce((sum, view) => sum + view.bytes, 0);
const partitionMetrics = () =>
  getSessionRowSelectionMetrics().partitions.reduce(
    (sum, counter) => ({ hits: sum.hits + counter.hits, misses: sum.misses + counter.misses }),
    { hits: 0, misses: 0 },
  );
let baselineRetirements = 0;
const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
  if (event.type === "sessions.list.baseline.retired" && event.cause === "view-evicted") {
    baselineRetirements++;
  }
});
const inspector = values.mode === "allocation" ? new Session() : undefined;
try {
  cache.setRows(cache.get("sidebar"), sidebar, true);
  queries.forEach((opts) => read(opts, cache));
  const originalPartitions = queries.flatMap((opts) => {
    const retained = cache.partitions(cache.get(String(opts.limit)));
    return partitions.map((partition) => new WeakRef(retained.get(partition.revision)!));
  });
  await setImmediate();
  await waitForDiagnosticEventsDrained();
  globalThis.gc?.();
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16_384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const initialEstimatedBytes = cacheBytes(cache);
  let peakEstimatedBytes = initialEstimatedBytes;
  let baselineMisses = 0;
  const before = partitionMetrics();
  const cpu = process.cpuUsage();
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index++) {
    const key = keys[index % keys.length]!;
    const previous = rows.get(key)!;
    const row = {
      ...previous,
      entry: { ...previous.entry, updatedAt: now + 10_000 + index },
    };
    rows.set(key, row);
    selection.change({
      kind: "row",
      id: identity(row),
      key,
      agentId: "main",
      row: selectionRow(row),
      scope: "session-entry",
    });
    const baseline = Array.from(cache.values()).find((view) => view.key === "sidebar");
    if (baseline?.rows !== sidebar) {
      baselineMisses++;
      cache.setRows(cache.get("sidebar"), sidebar, true);
    }
    queries.forEach((opts) => read(opts, cache));
    peakEstimatedBytes = Math.max(peakEstimatedBytes, cacheBytes(cache));
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const cpuDelta = process.cpuUsage(cpu);
  const hostLoadAfter = loadavg();
  const sampledAllocatedBytes = inspector
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0,
      )
    : null;
  await setImmediate();
  await waitForDiagnosticEventsDrained();
  const after = partitionMetrics();
  const finalEstimatedBytes = cacheBytes(cache);
  // Collection is observation only, outside timing; eviction must never await it.
  for (let pass = 0; pass < 2; pass++) {
    await setImmediate();
    globalThis.gc?.();
  }
  const originalPartitionsStillReachable = originalPartitions.filter((ref) => ref.deref()).length;
  const fresh = new SessionListViewCache();
  let currentLiveEstimatedBytes: number;
  let finalSelectionDigest: string;
  try {
    fresh.setRows(fresh.get("sidebar"), sidebar, true);
    const final = queries.map((opts) => {
      const result = read(opts, cache);
      assert.deepEqual(result, read(opts, fresh));
      assert.deepEqual({ ...result, involvingProfileId: undefined }, read(opts));
      return result;
    });
    currentLiveEstimatedBytes = cacheBytes(fresh);
    finalSelectionDigest = createHash("sha256").update(JSON.stringify(final)).digest("hex");
  } finally {
    fresh.clear();
  }
  const output = JSON.stringify(
    {
      mode: values.mode,
      iterations,
      corpusRows: rows.size,
      partitions: partitions.length,
      queryViews: queries.length,
      listReads: iterations * queries.length,
      baselineMisses,
      baselineRetirements,
      initialEstimatedBytes,
      peakEstimatedBytes,
      finalEstimatedBytes,
      currentLiveEstimatedBytes,
      originalPartitions: originalPartitions.length,
      originalPartitionsStillReachable,
      partitionHits: after.hits - before.hits,
      partitionMisses: after.misses - before.misses,
      cpuMs: (cpuDelta.user + cpuDelta.system) / 1_000,
      elapsedMs,
      sampledAllocatedBytes,
      finalSelectionDigest,
      hostLoadBefore,
      hostLoadAfter,
    },
    null,
    2,
  );
  if (values.output) {
    writeFileSync(values.output, output + "\n");
  }
  console.log(output);
} finally {
  inspector?.disconnect();
  unsubscribe();
  cache.clear();
}
