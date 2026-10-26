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
    runs: { type: "string", default: "500" },
    workload: { type: "string", default: "settled" },
    "yield-ms": { type: "string", default: "1" },
    "start-at": { type: "string", default: "0" },
    "gc-log": { type: "string" },
    output: { type: "string" },
  },
});
const integer = (name: keyof typeof values, min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const operations = integer("operations", 1);
const runCount = integer("runs", 10);
const yieldMs = integer("yield-ms", 0);
const startAt = integer("start-at", 0);
const workload = values.workload;
assert.ok(workload === "settled" || workload === "mixed", "--workload must be settled or mixed");
assert.ok(global.gc, "Run with --expose-gc");
const stateDir = values["state-dir"]
  ? path.resolve(values["state-dir"])
  : mkdtempSync(path.join(os.tmpdir(), "subagent-sweep-"));
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
// Identify the main isolate before source imports can start a worker.
marker("identify-start");
global.gc();
marker("identify-stop");

const [memory, { createSubagentRegistrySweeper }, agentRuns] = await Promise.all([
  import("../../src/agents/subagents/registry/subagent-registry-memory.js"),
  import("../../src/agents/subagents/registry/subagent-registry-sweeper.js"),
  import("../../src/infra/agent-run-registry.js"),
]);
const { subagentRuns, immutableSubagentRun } = memory;
const unexpected = () => {
  throw new Error("The idle sweep attempted a lifecycle, storage, or external effect");
};
let lifecycleSweeps = 0;
const sweeper = createSubagentRegistrySweeper({
  runs: subagentRuns,
  resumedRuns: new Set(),
  clearPendingLifecycleError: unexpected,
  clearPendingLifecycleTimeout: unexpected,
  sweepPendingLifecycle: () => {
    lifecycleSweeps++;
  },
  completeSubagentRunWithRecovery: unexpected,
  getGatewayRecoveryRuntime: () => undefined,
  finalizeInterruptedSubagentRun: unexpected,
  startSubagentAnnounceCleanupFlow: unexpected,
  completeCleanupBookkeeping: unexpected,
  resumeRequesterSettleWake: unexpected,
  resumePendingRequesterSettlements: () => false,
  isCleanupOwnerCurrent: unexpected,
  isTerminalTailActive: () => false,
  sessionEffectsHostCurrent: unexpected,
  shouldSuppressSessionEffects: unexpected,
  discardTerminalDelivery: unexpected,
  shouldEmitEndedHookForRun: unexpected,
  emitSubagentEndedHookForRun: unexpected,
  callGateway: unexpected,
  cleanupCollectorLaunchResources: unexpected,
  runContextEngineSubagentEnded: unexpected,
  notifyContextEngineSubagentEnded: unexpected,
  retireSupersededRun: unexpected,
  retireObligations: unexpected,
  getRunsForChildSession: memory.getSubagentRunsForChildSession,
  getRunsForCollectorGroup: memory.getSubagentRunsForCollectorGroup,
  warn: unexpected,
});

const composition = { settled: 0, running: 0, pendingDelivery: 0, futureArchive: 0 };
const claims = new Map<string, string | undefined>();
function makeRun(index: number): SubagentRunRecord {
  const entry: SubagentRunRecord = {
    runId: `sweep-run-${index}`,
    childSessionKey: `agent:main:subagent:sweep-${index}`,
    childAgentId: "main",
    childSessionIdentity: { sessionId: `session-${index}`, lifecycleRevision: `revision-${index}` },
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    createdAt: 100 + index,
    task: `Synthetic retained task ${index}`,
    cleanup: "keep",
    expectsCompletionMessage: true,
    execution: {
      status: "terminal",
      startedAt: 200 + index,
      endedAt: 300 + index,
      outcome: { status: "ok" },
    },
    completion: { required: true, resultText: "Synthetic retained result" },
    delivery: { status: "delivered" },
    cleanupCompletedAt: 400 + index,
  };
  if (workload === "mixed" && index % 10 === 0) {
    composition.running++;
    entry.execution = { status: "running", startedAt: 200 + index };
    entry.delivery = { status: "pending" };
    delete entry.completion;
    delete entry.cleanupCompletedAt;
    claims.set(
      entry.runId,
      agentRuns.claimAgentRunContext(entry.runId, {
        sessionKey: entry.childSessionKey,
        sessionId: entry.childSessionIdentity?.sessionId,
        agentId: "main",
      }),
    );
  } else if (workload === "mixed" && index % 10 === 1) {
    composition.pendingDelivery++;
    entry.delivery = { status: "pending" };
    delete entry.cleanupCompletedAt;
  } else if (workload === "mixed" && index % 10 === 2) {
    composition.futureArchive++;
    // A deterministic future deadline keeps paired fixtures identical.
    entry.archiveAtMs = Number.MAX_SAFE_INTEGER;
  } else {
    composition.settled++;
  }
  return immutableSubagentRun(entry);
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
    const underRegistry = owned || node.callFrame.url.includes("/subagents/registry/");
    totalBytes += node.selfSize;
    if (underRegistry) {
      registryBytes += node.selfSize;
    }
    node.children.forEach((child) => visit(child, underRegistry));
  };
  visit(profile.head);
  return {
    totalBytes,
    bytesPerSweep: totalBytes / operations,
    registryBytes,
    registryBytesPerSweep: registryBytes / operations,
    // The production idle timer runs once every 60 seconds; this is an extrapolation.
    projectedBytesPerIdleMinute: totalBytes / operations,
    projectedRegistryBytesPerIdleMinute: registryBytes / operations,
  };
}

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
  assert.equal(subagentRuns.size, 0, "The harness requires an empty process-local registry");
  const expected = Array.from({ length: runCount }, (_, index) => makeRun(index));
  for (const entry of expected) {
    subagentRuns.set(entry.runId, entry);
  }
  const expectedJson = JSON.stringify(expected);
  const assertUnchanged = () => {
    assert.equal(subagentRuns.size, expected.length);
    for (const entry of expected) {
      assert.equal(subagentRuns.get(entry.runId), entry, "A sweep replaced a retained run");
    }
    assert.equal(JSON.stringify([...subagentRuns.values()]), expectedJson);
  };
  for (let index = 0; index < 100; index++) {
    await sweeper.sweepOnce();
  }
  assertUnchanged();
  global.gc();
  await nextTurn();
  inspector.connect();
  loop.enable();
  await delay(10);
  writeSync(1, `SWEEP_READY ${JSON.stringify({ pid: process.pid, stateDir, startAt })}\n`);
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
  for (let index = 0; index < operations; index++) {
    const started = performance.now();
    await sweeper.sweepOnce();
    latency.push(performance.now() - started);
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
  assertUnchanged();
  assert.equal(lifecycleSweeps, operations + 100);
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
    scope: "production registry sweeper and canonical memory; no Gateway/model latency claim",
    node: process.version,
    workload,
    runCount,
    composition,
    operations,
    yieldMs,
    startAt,
    stateDir,
    profilePath,
    idleSweepIntervalMs: 60_000,
    allocationScope:
      "whole capture includes timing/yield overhead; registry stacks are also reported",
    unchangedRecordsSha256: hash("sha256", expectedJson, "hex"),
    lifecycleSweeps,
    externalEffects: 0,
    allocation: allocation(profile),
    profiledSweepLatency: distribution(latency),
    elapsedMs: measuredEnd - measuredStart,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    gc: {
      total: totalGc,
      msPerSweep: totalGc.totalMs / operations,
      projectedMsPerIdleMinute: totalGc.totalMs / operations,
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
    promotion: promotion
      ? { ...promotion, bytesPerSweep: promotion.promotedBytes / operations }
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
  await sweeper.reset();
  subagentRuns.clear();
  for (const [runId, claim] of claims) {
    agentRuns.releaseAgentRunContext(runId, claim);
  }
}
