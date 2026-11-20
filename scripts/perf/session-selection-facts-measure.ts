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
 * --sidebar-counts --listeners 1 --sessions 15000 measures the real sidebar count
 * filter with updates across 15 live rows. --filter-source <saved-session-list-filters.ts>
 * pins that owner from any path. Compare work counts, selection digest, CPU and allocation
 * in separate timing/allocation passes; static exclusions must skip disclosure reads
 * without changing totals, facets or membership of the returned page.
 * --selection-shapes compares retained paging, Activity people facets and sidebar
 * owner counts at --sessions 15000/60000, with row churn across 15 live sessions.
 * --list-source and --view-cache-source load pinned owner copies from any path.
 * --cache-pressure --sidebar-counts --listeners 1 measures 22 audience slots with
 * three 200-row sidebar views and one count query each. Acceptance: preserve all
 * 66 conditional sidebar baselines at 15k/60k rows; report heap and filter visits.
 * Count acceleration may be retired under the existing byte budget. Run pressure
 * separately from timing/allocation; do not call cache admission wall-time proof.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
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
import { createSessionIdentityProjection } from "../../src/gateway/session-identity-projection.js";
import { readSessionListSelectionFacts } from "../../src/gateway/session-list-target.js";
import type { Row, SelectionChange } from "../../src/gateway/session-row-projection-record.js";
import { createProfileSessionEntryFilter } from "../../src/gateway/session-sharing-read.js";
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
    "sidebar-counts": { type: "boolean", default: false },
    "selection-shapes": { type: "boolean", default: false },
    "cache-pressure": { type: "boolean", default: false },
    "list-source": { type: "string", default: "src/gateway/session-utils-list.ts" },
    "view-cache-source": { type: "string", default: "src/gateway/session-list-view-cache.ts" },
    "filter-source": { type: "string", default: "src/gateway/session-list-filters.ts" },
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
const filterSource = path.resolve(values["filter-source"]);
const filterUrl = `${new URL("../../src/gateway/session-list-filters.ts", import.meta.url).href}?measured-filter`;
const filterHook = registerHooks({
  load(url, context, nextLoad) {
    return url === filterUrl
      ? {
          format: "module-typescript",
          source: readFileSync(filterSource, "utf8"),
          shortCircuit: true,
        }
      : nextLoad(url, context);
  },
});
const { filterSessionEntries }: typeof import("../../src/gateway/session-list-filters.js") =
  await import(filterUrl);
filterHook.deregister();
const listSource = path.resolve(values["list-source"]);
const cacheSource = path.resolve(values["view-cache-source"]);
const listUrl = `${new URL("../../src/gateway/session-utils-list.ts", import.meta.url).href}?measured-list`;
const cacheUrl = `${new URL("../../src/gateway/session-list-view-cache.ts", import.meta.url).href}?measured-cache`;
const ownerHook = registerHooks({
  load(url, context, nextLoad) {
    const ownerSource = url === listUrl ? listSource : url === cacheUrl ? cacheSource : undefined;
    if (!ownerSource) {
      return nextLoad(url, context);
    }
    const contents = readFileSync(ownerSource, "utf8");
    return {
      format: "module-typescript",
      source:
        url === listUrl
          ? contents.replace('"./session-list-filters.js"', JSON.stringify(filterUrl))
          : contents,
      shortCircuit: true,
    };
  },
});
const { selectSessionEntries }: typeof import("../../src/gateway/session-utils-list.js") =
  await import(listUrl);
const { SessionListViewCache }: typeof import("../../src/gateway/session-list-view-cache.js") =
  await import(cacheUrl);
ownerHook.deregister();
assert(!values["cache-pressure"] || (values["sidebar-counts"] && listenerCount === 1));
const sharing = createProfileSessionEntryFilter(
  { profileId: "synthetic", sessionCap: "view" },
  (actor) => actor?.id === "synthetic",
);
const now = Date.UTC(2026, 9, 27);
const pulseBoundaries = Array.from({ length: 13 }, (_, index) => Date.UTC(2025, 10 + index, 1));
const cfg = { agents: { entries: { main: {}, ops: {} } } };
const agents = new Set(["main", "ops"]);
const storePath = "/synthetic/selection-facts-measure.sqlite";
const context = {
  ...buildSessionListRowMetadataContext({
    now,
    subagentRuns: buildSubagentSessionListReadIndex(now, [], new Map()),
    userProfileIdentityById: new Map([
      [
        "synthetic",
        {
          kind: "resolved",
          profileId: "synthetic",
          label: "Synthetic",
          avatarUrl: "/synthetic/avatar",
        },
      ],
    ]),
  }),
  identityProjection: createSessionIdentityProjection(),
};
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
const workloads = values["selection-shapes"]
  ? (["page", "people", "sidebar"] as const)
  : values["sidebar-counts"]
    ? (["sidebar"] as const)
    : (["unchanged", "presentation", "metadata"] as const);
for (const name of workloads) {
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
  let lastParams: Parameters<typeof selectSessionEntries>[0] | undefined;
  let revision = 0;
  let filterCalls = 0;
  let filtered:
    | ReturnType<typeof filterSessionEntries>
    | ReturnType<typeof selectSessionEntries>
    | undefined;
  const queryShape = name === "sidebar" || name === "page" || name === "people";
  const retained: NonNullable<Parameters<typeof selectSessionEntries>[0]["retained"]> = new Map();
  const run = () => {
    const index = revision++ % (queryShape ? Math.min(15, sessions) : sessions);
    let row = rows[index]!;
    if (name !== "unchanged") {
      const entry = {
        ...row.entry!,
        ...(queryShape
          ? { updatedAt: now + revision, lastActivityAt: now + revision }
          : name === "presentation"
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
      storePath: row.storeTarget.storePath,
      row: records.selectionRow(row),
    };
    notifyListeners(listeners, change, (error) => {
      throw error;
    });
    if (queryShape) {
      const selected = owners[0]!.read(name === "people" ? "activity" : "updatedAt");
      const params: Parameters<typeof selectSessionEntries>[0] = {
        cfg,
        now,
        opts:
          name === "page"
            ? { limit: 200, ownerFirst: true }
            : name === "people"
              ? {
                  limit: 100,
                  includePeople: true,
                  activityPulseBoundaries: pulseBoundaries,
                  excludeSubagents: true,
                  excludeDock: true,
                  archived: "all",
                  sortBy: "activity",
                }
              : {
                  limit: 1,
                  includeOwnerSessionCounts: true,
                  excludeSubagents: true,
                  excludeCron: true,
                  excludeSystem: true,
                  excludeDock: true,
                },
        entries: selected.entries,
        entriesSorted: true,
        ownerFirstActorId: name === "page" ? "synthetic" : undefined,
        getTarget: selected.get,
        configuredAgentIds: agents,
        getRowContext: () => context,
        userProfileIdentityById: context.userProfileIdentityById,
        involvementKeys: selected.involvementKeys,
        partitions: selected.partitions,
        retained,
        entryFilter: (key, entry) => {
          filterCalls++;
          return sharing(key, entry);
        },
      };
      lastParams = params;
      filtered = selectSessionEntries(params);
    }
  };
  for (let index = 0; index < 500; index++) {
    run();
  }
  if (values["cache-pressure"]) {
    assert(lastParams);
    const cache = new SessionListViewCache();
    const projected = new WeakMap<object, { key: string; kind: "direct"; updatedAt: number }>();
    const rounds = [];
    for (let round = 0; round < 2; round++) {
      const filteredBefore = filterCalls;
      if (round) {
        run();
      }
      for (let audience = 0; audience < 22; audience++) {
        for (const sortBy of ["updatedAt", "lastInteractionAt", "activity"] as const) {
          const selected = owners[0]!.read(sortBy);
          const view = cache.get(`selection:${audience}:${sortBy}`);
          view.selection = selectSessionEntries({
            ...lastParams,
            opts: { limit: 200, archived: "all", sortBy },
            entries: selected.entries,
            partitions: selected.partitions,
            retained: cache.partitions(view),
          });
          cache.update(view);
          const sidebarRows = view.selection.entries.map(([key, entry]) => {
            let row = projected.get(entry);
            if (!row) {
              row = Object.freeze({
                key,
                kind: "direct" as const,
                updatedAt: entry.updatedAt ?? 0,
              });
              projected.set(entry, row);
            }
            return row;
          });
          cache.setRows(cache.get(`rows:${audience}:${sortBy}`), sidebarRows, true);
        }
        const selected = owners[0]!.read("updatedAt");
        const view = cache.get(`counts:${audience}`);
        view.selection = selectSessionEntries({
          ...lastParams,
          entries: selected.entries,
          partitions: selected.partitions,
          retained: cache.partitions(view),
        });
        cache.update(view);
      }
      const views = [...cache.values()];
      rounds.push({
        round,
        filters: filterCalls - filteredBefore,
        retainedSidebar: views.filter((view) => view.key.startsWith("rows:") && view.rows).length,
        views: views.length,
        bytes: views.reduce((sum, view) => sum + view.bytes, 0),
        retainedCountPartitions: views
          .filter((view) => view.key.startsWith("counts:"))
          .reduce((sum, view) => sum + (view.partitions?.size ?? 0), 0),
      });
    }
    global.gc();
    results.push({ name, rounds, memoryAfterGc: process.memoryUsage() });
    cache.clear();
    continue;
  }
  filterCalls = 0;
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
  if (queryShape) {
    assert(filtered);
    assert(filtered.ownerFacet.some((owner) => owner.id === "synthetic"));
    if (name === "sidebar") {
      assert(
        filtered.ownerSessionCounts?.some(
          (count) => count.profileId === "synthetic" && count.open > 0,
        ),
      );
    }
  }
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
    filterCallsPerUpdate: filterCalls / iterations,
    selectionDigest: filtered && digest(filtered),
    hostLoadBefore,
    hostLoadAfter,
    elapsedMs,
    mainThreadCpuMs: (used.user + used.system) / 1000,
    mainThreadCpuUsPerUpdate: (used.user + used.system) / iterations,
    sampledBytesPerUpdate: bytes === undefined ? undefined : bytes / iterations,
    p50Ms: times[Math.floor(iterations * 0.5)],
    p99Ms: times[Math.min(iterations - 1, Math.floor(iterations * 0.99))],
    maxMs: times.at(-1),
    over180: times.filter((time) => time > 180).length,
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
    listSourceSha256: createHash("sha256").update(readFileSync(listSource)).digest("hex"),
    cacheSourceSha256: createHash("sha256").update(readFileSync(cacheSource)).digest("hex"),
    filterSourceSha256: createHash("sha256").update(readFileSync(filterSource)).digest("hex"),
    sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
    recordSource,
    recordSourceSha256: createHash("sha256").update(readFileSync(recordSource)).digest("hex"),
    sessions,
    listenerCount,
    mode: values.mode,
    results,
  }),
);
