// Run only on an approved benchmark host with --expose-gc --trace-gc-nvp.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, writeSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { mock } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    operations: { type: "string", default: "4000" },
    runs: { type: "string", default: "6000" },
    "yield-ms": { type: "string", default: "1" },
    "start-at": { type: "string", default: "0" },
    "gc-log": { type: "string" },
    output: { type: "string" },
  },
});
const integer = (name: keyof typeof values, min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const operations = integer("operations", 1);
const runCount = integer("runs", 62);
const yieldMs = integer("yield-ms", 0);
const startAt = integer("start-at", 0);
assert.ok(global.gc, "Run with --expose-gc");
const stateDir = values["state-dir"]
  ? path.resolve(values["state-dir"])
  : mkdtempSync(path.join(os.tmpdir(), "subagent-capture-"));
if (values["state-dir"]) {
  mkdirSync(stateDir, { mode: 0o700 });
}
for (const directory of ["home", "tmp"]) {
  mkdirSync(path.join(stateDir, directory));
}
const configPath = path.join(stateDir, "openclaw.json");
writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};
const profilePath = path.join(stateDir, "allocation.heapprofile");
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
// Identify the main isolate before any source import can start a worker.
marker("identify-start");
global.gc();
marker("identify-stop");

const [
  { prepareSessionMaintenancePreservation },
  { subagentRuns },
  persistence,
  fixture,
  database,
] = await Promise.all([
  import("../../src/config/sessions/store-maintenance-preserve.js"),
  import("../../src/agents/subagents/registry/subagent-registry-memory.js"),
  import("../../src/agents/subagents/registry/subagent-registry-persistence.js"),
  import("../../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js"),
  import("../../src/state/openclaw-state-db.js"),
]);
await import("../../src/agents/subagents/registry/subagent-registry-maintenance.js");

const runId = (index: number) => `capture-run-${index}`;
const childKey = (index: number) => `agent:main:subagent:capture-${index}`;
function run(index: number, protectedRun = index < 60): SubagentRunRecord {
  return {
    runId: runId(index),
    childSessionKey: childKey(index),
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    createdAt: 100 + index,
    task: `Synthetic retained task ${index}`,
    cleanup: "keep",
    expectsCompletionMessage: true,
    execution: { status: "terminal", startedAt: 200 + index, endedAt: 300 + index },
    completion: { required: true, resultText: "Synthetic retained result" },
    delivery: protectedRun ? { status: "pending" } : { status: "delivered" },
    ...(protectedRun ? {} : { cleanupCompletedAt: 400 + index }),
  };
}

function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count,
    totalMs,
    meanMs: count ? totalMs / count : 0,
    maxMs: sorted.at(-1) ?? 0,
    p95: { samples: count, ms: sorted[Math.ceil(count * 0.95) - 1] ?? null },
    p99: { samples: count, ms: sorted[Math.ceil(count * 0.99) - 1] ?? null },
  };
}

function allocation(profile: HeapProfiler.SamplingHeapProfile) {
  let totalBytes = 0;
  let registryBytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, owned = false) => {
    const underRegistry = owned || node.callFrame.url.includes("subagent-registry-");
    totalBytes += node.selfSize;
    if (underRegistry) {
      registryBytes += node.selfSize;
    }
    node.children.forEach((child) => visit(child, underRegistry));
  };
  visit(profile.head);
  return {
    totalBytes,
    bytesPerOperation: totalBytes / operations,
    registryBytes,
    registryBytesPerOperation: registryBytes / operations,
  };
}

let prepared: Awaited<ReturnType<typeof prepareSessionMaintenancePreservation>> | undefined;
const inspector = new Session();
const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
const loop = monitorEventLoopDelay({ resolution: 1 });
const collections: { kind: number; ms: number }[] = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;
function recordGc(entries: PerformanceEntry[]) {
  for (const entry of entries) {
    if (entry.startTime >= measuredStart && entry.startTime < measuredEnd) {
      collections.push({
        kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  }
}

try {
  const rows = new Map(Array.from({ length: runCount }, (_, index) => [runId(index), run(index)]));
  fixture.saveSubagentRegistryToSqlite(rows);
  prepared = await prepareSessionMaintenancePreservation(path.join(stateDir, "sessions.json"));
  assert.deepEqual(
    prepared.capture().providerKeys,
    Array.from({ length: 60 }, (_, i) => childKey(i)).toSorted(),
  );

  // Current live rows override durable facts in both directions; live-only rows also count.
  subagentRuns.set(runId(0), run(0, false));
  subagentRuns.set(runId(60), run(60, true));
  subagentRuns.set(runId(runCount), run(runCount, true));
  // Real worker commit receipts must update this already-prepared preservation owner.
  const changed = [1, 2, 61];
  await persistence.mutateSubagentRuns(
    changed.map(runId),
    () => ({
      value: undefined,
      postimages: new Map<string, SubagentRunRecord | null>([
        [runId(1), run(1, false)],
        [runId(2), null],
        [runId(61), run(61, true)],
      ]),
    }),
    { runs: new Map(changed.map((index) => [runId(index), rows.get(runId(index))!])) },
  );
  const expected = [
    ...Array.from({ length: 57 }, (_, index) => childKey(index + 3)),
    childKey(60),
    childKey(61),
    childKey(runCount),
  ].toSorted();
  assert.deepEqual(prepared.capture().providerKeys, expected);
  assert.deepEqual(prepared.refreshCandidates([childKey(61)]).providerKeys, expected);

  // Count registry row writes separately; instrumentation is absent during profiling.
  const ids = new Set([...rows.keys(), runId(runCount)]);
  // oxlint-disable-next-line typescript/unbound-method -- The probe forwards the original receiver.
  const originalSet = Map.prototype.set;
  let rowWrites = 0;
  const probe = mock.method(
    Map.prototype,
    "set",
    function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (typeof key === "string" && ids.has(key)) {
        rowWrites++;
      }
      return originalSet.call(this, key, value);
    },
  );
  try {
    prepared.capture();
  } finally {
    probe.mock.restore();
    probe.mock.resetCalls();
  }
  for (let index = 0; index < 100; index++) {
    prepared.capture();
  }
  global.gc();
  await nextTurn();
  inspector.connect();
  loop.enable();
  await delay(10);
  writeSync(1, `CAPTURE_READY ${JSON.stringify({ pid: process.pid, stateDir, startAt })}\n`);
  if (startAt) {
    assert.ok(Date.now() < startAt, "Missed --start-at after setup and warmup");
    await delay(startAt - Date.now());
  }
  const latency: number[] = [];
  observer.observe({ entryTypes: ["gc"] });
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  loop.reset();
  marker("heap-start");
  measuredStart = performance.now();
  let checksum = 0;
  for (let index = 0; index < operations; index++) {
    const started = performance.now();
    const keys = prepared.capture().providerKeys;
    latency.push(performance.now() - started);
    checksum += keys.length;
    await (yieldMs ? delay(yieldMs) : nextTurn());
  }
  measuredEnd = performance.now();
  const usedCpu = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  marker("heap-stop");
  loop.disable();
  await nextTurn();
  recordGc(observer.takeRecords());
  observer.disconnect();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  assert.equal(checksum, expected.length * operations);
  assert.deepEqual(prepared.capture().providerKeys, expected);
  writeFileSync(profilePath, JSON.stringify(profile));
  const gc = (kind?: number) =>
    distribution(
      collections
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map((entry) => entry.ms),
    );
  const totalGc = gc();
  const promotion = values["gc-log"]
    ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
    : undefined;
  const result = {
    scope: "production session maintenance preservation owner; no Gateway/RPC latency claim",
    node: process.version,
    runCount,
    operations,
    yieldMs,
    startAt,
    stateDir,
    profilePath,
    protectedKeys: expected.length,
    protectedKeysSha256: hash("sha256", JSON.stringify(expected), "hex"),
    registryMapRowWritesPerCapture: rowWrites,
    allocation: allocation(profile),
    profiledCaptureLatency: distribution(latency),
    elapsedMs: measuredEnd - measuredStart,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    gc: {
      total: totalGc,
      msPerOperation: totalGc.totalMs / operations,
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
    promotion: promotion
      ? { ...promotion, bytesPerOperation: promotion.promotedBytes / operations }
      : null,
    eventLoop: {
      samples: loop.count,
      maxMs: loop.max / 1e6,
      p95: { samples: loop.count, ms: loop.percentile(95) / 1e6 },
      p99: { samples: loop.count, ms: loop.percentile(99) / 1e6 },
    },
    memory: { before, after, peakRssBytesIncludingSetup: process.resourceUsage().maxRSS * 1024 },
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    writeFileSync(values.output, output);
  }
  writeSync(1, output);
} finally {
  observer.disconnect();
  loop.disable();
  inspector.disconnect();
  prepared?.dispose();
  subagentRuns.clear();
  await database.closeOpenClawStateDatabaseAsync();
}
