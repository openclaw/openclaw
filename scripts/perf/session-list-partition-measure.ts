/**
 * Resident selection owner benchmark; no Gateway/transport or authorization claim.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-list-partition-measure.ts \
 *   --source src/gateway/session-utils-list.ts --iterations 2500 --mode timing --churn 1
 * Repeat with --mode allocation in a fresh process. A baseline source copy must sit
 * beside session-utils-list.ts so its relative imports retain the same dependency closure.
 * When ordering helpers differ, also copy the baseline session-list-order.ts beside it
 * and point the baseline list import at that copy; never measure baseline with candidate helpers.
 * Run counterbalanced baseline/candidate processes on the approved benchmark host.
 * Acceptance: identical full-selection oracle and digests, page-bounded retained
 * candidate reads, and lower CPU/allocation without a reproducible adverse sibling.
 * Cold construction precedes measurement; --churn replaces N rows before each call.
 * Allocation sampling includes collected objects but excludes TypedArray backing stores.
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
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { buildSubagentSessionListReadIndex } from "../../src/agents/subagents/registry/subagent-registry-read.js";
import { createSessionIdentityProjection } from "../../src/gateway/session-identity-projection.js";
import type { SessionListFilteredEntries } from "../../src/gateway/session-list-filters.js";
import { readSessionListSelectionFacts } from "../../src/gateway/session-list-target.js";
import { identity, type SelectionRow } from "../../src/gateway/session-row-projection-record.js";
import { createSessionRowSelection } from "../../src/gateway/session-row-selection.js";
import { buildSessionListRowMetadataContext } from "../../src/gateway/session-utils-projection.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "src/gateway/session-utils-list.ts" },
    iterations: { type: "string", default: "2500" },
    sessions: { type: "string", default: "10800" },
    mode: { type: "string", default: "timing" },
    churn: { type: "string", default: "0" },
  },
});
assert(global.gc, "run with --expose-gc");
assert(values.mode === "timing" || values.mode === "allocation");
const integer = (name: "iterations" | "sessions" | "churn", min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const iterations = integer("iterations", 1);
const sessions = integer("sessions", 200);
const churn = integer("churn", 0);
const source = path.resolve(values.source);
const { selectSessionEntries }: typeof import("../../src/gateway/session-utils-list.js") =
  await import(pathToFileURL(source).href);
const now = Date.UTC(2026, 9, 27);
const cfg = { agents: { entries: { main: {}, ops: {} } } };
const agents = new Set(["main", "ops"]);
const storePath = "/synthetic/partition-measure.sqlite";
const context = buildSessionListRowMetadataContext({
  now,
  subagentRuns: buildSubagentSessionListReadIndex(now, [], new Map()),
});
context.identityProjection = createSessionIdentityProjection();
for (const id of ["ada", "bob"]) {
  context.userProfileIdentityById.set(id, {
    kind: "resolved",
    profileId: id,
    label: id,
    avatarUrl: "/synthetic/avatar",
    hasUploadedAvatar: false,
  });
}
const cases: Array<[string, SessionsListParams]> = [
  ["sidebar", {}],
  ["offset", { offset: 50 }],
  ["activity", { sortBy: "activity" }],
  ["interaction", { sortBy: "lastInteractionAt" }],
  ["owner-first", { ownerFirst: true }],
  ["owner", { ownerId: "ada" }],
  ["involving", { involvingMe: true }],
  ["roots", { excludeSubagents: true }],
];
const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const results = [];
for (const [name, query] of cases) {
  const owner = createSessionRowSelection(
    cfg,
    {
      agentId: undefined,
      path: storePath,
      paths: new Map([[storePath, 0]]),
      configuredAgentIds: agents,
      ownerAgentIds: agents,
    },
    false,
    () => context,
  );
  const rows: SelectionRow[] = Array.from({ length: sessions }, (_, index) => {
    const agentId = index % 3 ? "main" : "ops";
    const key = `agent:${agentId}:${index % 5 ? "subagent" : "dashboard"}:fixture-${index}`;
    const entry = {
      sessionId: `fixture-${index}`,
      updatedAt: now - ((index * 617) % sessions) * 1000,
      lastActivityAt: now - ((index * 719) % sessions) * 1000,
      lastInteractionAt: now - ((index * 317) % sessions) * 1000,
      createdActor: {
        type: "human" as const,
        source: "profile" as const,
        id: index % 2 ? "ada" : "bob",
      },
      ...(index % 7 === 0 ? { archivedAt: now - 1000 } : {}),
      ...(index % 50 === 0 ? { pinnedAt: now + index } : {}),
    };
    const row: SelectionRow = {
      key,
      agentId,
      storeTarget: { agentId, storePath },
      entry,
      selection: readSessionListSelectionFacts(key, entry),
      hasBoard: false,
      generation: Symbol("row"),
    };
    owner.add(row);
    return row;
  });
  const opts: SessionsListParams = {
    limit: 200,
    archived: "all",
    includeGlobal: true,
    includeUnknown: true,
    ...query,
  };
  const retained = new WeakMap<object, SessionListFilteredEntries>();
  const read = (cache: WeakMap<object, SessionListFilteredEntries> | null = retained) => {
    const selected = owner.read(opts.sortBy ?? "updatedAt");
    return selectSessionEntries({
      cfg,
      opts,
      now,
      ...selected,
      entriesSorted: true,
      partitions: cache ? selected.partitions : undefined,
      retained: cache ?? undefined,
      getTarget: selected.get,
      getRowContext: () => context,
      userProfileIdentityById: context.userProfileIdentityById,
      involvingActorId: opts.involvingMe ? "ada" : undefined,
      ownerFirstActorId: opts.ownerFirst ? "ada" : undefined,
    });
  };
  read();
  let candidateReads = 0;
  const originals = [];
  for (const partition of owner.read().partitions!) {
    const part = retained.get(partition.revision);
    if (!part) {
      continue;
    }
    for (const field of ["entries", "ownerEntries"] as const) {
      const entries = part[field];
      originals.push({ part, field, entries });
      part[field] = new Proxy(entries, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) {
            candidateReads++;
          }
          return Reflect.get(target, key, receiver);
        },
      });
    }
  }
  read();
  for (const { part, field, entries } of originals) {
    part[field] = entries;
  }
  let revision = 0;
  const run = () => {
    for (let count = 0; count < churn; count++) {
      const index = revision++ % rows.length;
      const previous = rows[index]!;
      const row = { ...previous, entry: { ...previous.entry, updatedAt: now + revision } };
      rows[index] = row;
      owner.change({ kind: "row", id: identity(row), key: row.key, agentId: row.agentId, row });
    }
    return read();
  };
  for (let index = 0; index < 100; index++) {
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
  const hostLoad = loadavg();
  const times = new Float64Array(iterations);
  const cpu = process.cpuUsage();
  const started = performance.now();
  let last = read();
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    last = run();
    times[index] = performance.now() - before;
  }
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const memory = process.memoryUsage();
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
  assert.equal(
    digest(last),
    digest(read(null)),
    `${name}: retained selection differs from full ordered filtering`,
  );
  times.sort();
  const gcByKind: Record<number, { count: number; ms: number; maxMs: number }> = {};
  for (const entry of collections) {
    const { kind } = (entry as PerformanceNodeEntry).detail as { kind: number };
    const group = (gcByKind[kind] ??= { count: 0, ms: 0, maxMs: 0 });
    group.count++;
    group.ms += entry.duration;
    group.maxMs = Math.max(group.maxMs, entry.duration);
  }
  const gcMs = collections.reduce((sum, entry) => sum + entry.duration, 0);
  results.push({
    name,
    iterations,
    candidateReads,
    hostLoad,
    elapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    cpuUsPerCall: (used.user + used.system) / iterations,
    p50Ms: times[Math.floor(iterations * 0.5)],
    p99Ms: times[Math.min(iterations - 1, Math.floor(iterations * 0.99))],
    sampledBytesPerCall: bytes === undefined ? undefined : bytes / iterations,
    gcMs,
    gcMsPerMinute: (gcMs * 60_000) / elapsedMs,
    gcCount: collections.length,
    gcByKind,
    gcMaxMs: Math.max(0, ...collections.map((entry) => entry.duration)),
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    digest: digest(last),
  });
}
console.log(
  JSON.stringify({
    node: process.version,
    source,
    sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
    sessions,
    churn,
    mode: values.mode,
    results,
  }),
);
