/**
 * Retained tool-classification publication cost (synthetic sessions, no database or Gateway).
 * Run each revision with Node 26.12:
 * node --import ./scripts/tsx.mjs scripts/perf/reply-classification-publication-measure.ts --output result.json
 * Repeat >=5 alternating pairs. Add --allocations for a separate collected-object heap pass.
 * For promotion, add Node --expose-gc --trace-gc-nvp and --gc-log trace.log, redirect stdout
 * to that log. Never use traced/sampled timings as untraced latency/GC evidence.
 */
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { retainReplyToolAuthorityClassification } from "../../src/auto-reply/reply/reply-tool-authority-cohort.js";
import { publishRetainedSessionEntryChange } from "../../src/config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    allocations: { type: "boolean" },
    "gc-log": { type: "string" },
  },
});
assert(values.output, "--output is required");
const operations = 200_000;
const sessionCount = 48;
const readersPerSession = 4;
const databaseIdentity = "synthetic-classification-publication";
const fixtures = Array.from({ length: sessionCount }, (_, index) => {
  const key = `agent:main:synthetic-${index}`;
  const entry: SessionEntry = {
    sessionId: `session-${index}`,
    updatedAt: 1,
    lifecycleRevision: "generation-1",
    sandbox: "required",
    createdActor: {
      type: "human",
      source: "profile",
      id: `actor-${index}`,
      label: "Synthetic actor",
      delegatedBy: { type: "agent", id: `parent-${index}` },
    },
  };
  const original = {
    storePath: "/synthetic/sessions",
    canonicalKey: key,
    storeKeys: [key],
    agentId: "main",
    source: { agentId: "main", path: "/synthetic/agent.db", databaseIdentity },
    sources: undefined,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
  };
  const retained = Array.from({ length: readersPerSession }, () => {
    const value = retainReplyToolAuthorityClassification(original, entry, () => {});
    assert(value);
    return value;
  });
  return { key, entry, retained };
});
function publish(index: number) {
  const fixture = fixtures[index % sessionCount]!;
  const entry = {
    ...fixture.entry,
    updatedAt: index,
    createdActor: structuredClone(fixture.entry.createdActor),
  };
  publishRetainedSessionEntryChange(
    databaseIdentity,
    fixture.key,
    entry,
    fixture.entry,
    true,
    entry,
  );
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((a, b) => a + b, 0),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? 0,
  };
}
const profilePath = `${values.output}.heapprofile`;
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
if (values["gc-log"]) {
  assert(global.gc, "Tracing requires --expose-gc");
  marker("identify-start");
  global.gc();
  marker("identify-stop");
}
for (let i = 0; i < 10_000; i++) {
  publish(i);
}
await nextTurn();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const collections: { kind: number; ms: number }[] = [];
let start = Infinity;
let end = Infinity;
const observer = new PerformanceObserver((list) =>
  recordGcCollections(list.getEntries(), collections, start, end),
);
observer.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
const latencies: number[] = [];
const cpuStart = process.cpuUsage();
marker("heap-start");
start = performance.now();
for (let i = 0; i < operations; i++) {
  const began = performance.now();
  publish(i);
  latencies.push(performance.now() - began);
  if (i % 100 === 99) {
    await nextTurn();
  }
}
end = performance.now();
marker("heap-stop");
const cpu = process.cpuUsage(cpuStart);
loop.disable();
await nextTurn();
await nextTurn();
observer.disconnect();
let allocation: { totalBytes: number; bytesPerPublication: number; stringifyBytes: number } | null =
  null;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  let totalBytes = 0;
  let stringifyBytes = 0;
  function visit(node: HeapProfiler.SamplingHeapProfileNode, inStringify = false) {
    totalBytes += node.selfSize;
    const nested = inStringify || node.callFrame.functionName === "stringifyStableValue";
    if (nested) {
      stringifyBytes += node.selfSize;
    }
    for (const child of node.children) {
      visit(child, nested);
    }
  }
  visit(profile.head);
  allocation = { totalBytes, bytesPerPublication: totalBytes / operations, stringifyBytes };
  await writeFile(profilePath, JSON.stringify(profile));
}
for (const fixture of fixtures) {
  for (const retained of fixture.retained) {
    retained.assertCurrent();
    retained.release();
  }
}
const gc = (kind?: number) =>
  distribution(
    collections
      .filter((value) => kind === undefined || value.kind === kind)
      .map((value) => value.ms),
  );
const report = {
  node: process.version,
  operations,
  sessionCount,
  readersPerSession,
  comparisons: operations * readersPerSession,
  verifiedReaders: sessionCount * readersPerSession,
  elapsedMs: end - start,
  cpuMs: (cpu.user + cpu.system) / 1000,
  latency: distribution(latencies),
  gc: {
    total: gc(),
    minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
    major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    incremental: gc(constants.NODE_PERFORMANCE_GC_INCREMENTAL),
    weak: gc(constants.NODE_PERFORMANCE_GC_WEAKCB),
  },
  loop: {
    count: loop.count,
    p95Ms: loop.percentile(95) / 1e6,
    p99Ms: loop.percentile(99) / 1e6,
    maxMs: loop.max / 1e6,
  },
  allocation,
  promotion: values["gc-log"] ? readGatewayGcTrace(values["gc-log"], profilePath) : null,
};
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
