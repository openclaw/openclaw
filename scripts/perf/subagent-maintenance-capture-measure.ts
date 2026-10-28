// Run only on an approved benchmark host with --expose-gc --trace-gc-nvp.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
import type { ControlledSubagentRunsReadContext } from "../../src/agents/subagents/registry/subagent-control-scope.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    operations: { type: "string", default: "4000" },
    runs: { type: "string", default: "6000" },
    "yield-ms": { type: "string", default: "1" },
    "interval-ms": { type: "string", default: "0" },
    "per-minute": { type: "string", default: "450" },
    "mutate-every": { type: "string", default: "0" },
    "start-at": { type: "string", default: "0" },
    "start-file": { type: "string" },
    allocations: { type: "boolean", default: false },
    "team-shape": { type: "boolean", default: false },
    flow: { type: "string", default: "maintenance" },
    "concentrated-root": { type: "boolean", default: false },
    "gc-log": { type: "string" },
    output: { type: "string" },
  },
});
const integer = (
  name:
    | "operations"
    | "runs"
    | "yield-ms"
    | "interval-ms"
    | "per-minute"
    | "mutate-every"
    | "start-at",
  min: number,
) => parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const operations = integer("operations", 1);
const runCount = integer("runs", 62);
const yieldMs = integer("yield-ms", 0);
const intervalMs = integer("interval-ms", 0);
const perMinute = integer("per-minute", 1);
const mutateEvery = integer("mutate-every", 0);
const flow = values.flow;
assert.ok(["maintenance", "prompt", "control"].includes(flow), "Invalid --flow");
let startAt = integer("start-at", 0);
assert.ok(global.gc, "Run with --expose-gc");
assert.ok(!values["team-shape"] || values["state-dir"], "--team-shape needs a new --state-dir");
assert.ok(!mutateEvery || values["team-shape"], "--mutate-every requires --team-shape");
assert.ok(flow === "maintenance" || values["team-shape"], "Read flows require --team-shape");
assert.ok(
  !values["concentrated-root"] || values["team-shape"],
  "--concentrated-root requires --team-shape",
);
const stateDir = values["state-dir"]
  ? path.resolve(values["state-dir"])
  : mkdtempSync(path.join(os.tmpdir(), "subagent-capture-"));
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
const teamShape = values["team-shape"]
  ? await generateTeamShapeFixture(
      parseTeamShapeOptions([
        "--state-dir",
        stateDir,
        "--runs",
        String(runCount),
        "--transcript-mib",
        "0",
      ]),
    )
  : undefined;
if (!teamShape) {
  if (values["state-dir"]) {
    mkdirSync(stateDir, { mode: 0o700 });
  }
  for (const directory of ["home", "tmp"]) {
    mkdirSync(path.join(stateDir, directory));
  }
  writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({ plugins: { enabled: false } }),
  );
}
process.env = teamShape?.env ?? {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), path.join(stateDir, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};

const [
  { prepareSessionMaintenancePreservation },
  { subagentRuns, compactSubagentRunForMemory },
  { isSubagentRunPayloadEvicted },
  persistence,
  fixture,
  database,
  agentRuns,
  { captureRuntimeConfigAsyncReader },
  { resolvePhysicalSessionStorePath },
  { buildActiveSubagentRuntimeContext },
  { buildControlledSubagentRunsReadContext },
] = await Promise.all([
  import("../../src/config/sessions/store-maintenance-preserve.js"),
  import("../../src/agents/subagents/registry/subagent-registry-memory.js"),
  import("../../src/agents/subagents/registry/subagent-run-payload-facts.js"),
  import("../../src/agents/subagents/registry/subagent-registry-persistence.js"),
  import("../../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/infra/agent-run-registry.js"),
  import("../../src/config/config.js"),
  import("../../src/config/sessions/session-store-path.js"),
  import("../../src/agents/subagents/registry/subagent-active-context.js"),
  import("../../src/agents/subagents/registry/subagent-control-scope.js"),
]);
await import("../../src/agents/subagents/registry/subagent-registry-maintenance.js");
const cfg = await captureRuntimeConfigAsyncReader()();

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
const claims = new Map<string, string>();
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
  const rows = teamShape
    ? fixture.loadSubagentRegistryFromSqlite()
    : new Map(Array.from({ length: runCount }, (_, index) => [runId(index), run(index)]));
  assert.equal(rows.size, runCount);
  let expected: string[];
  if (teamShape) {
    const keys = new Set<string>();
    const root = rows.values().next().value!.requesterSessionKey;
    for (const [id, original] of rows) {
      const parent = values["concentrated-root"] ? root : original.requesterSessionKey;
      const storePath = resolvePhysicalSessionStorePath(
        { sessionKey: parent, agentId: "main" },
        cfg,
      );
      const entry: SubagentRunRecord = {
        ...original,
        requesterSessionKey: parent,
        requesterDisplayKey: parent,
        controllerSessionKey: parent,
        requesterStorePath: storePath,
        controllerStorePath: storePath,
        ...(original.delivery?.payload
          ? {
              delivery: {
                ...original.delivery,
                payload: {
                  ...original.delivery.payload,
                  requesterSessionKey: parent,
                  requesterDisplayKey: parent,
                },
              },
            }
          : {}),
      };
      rows.set(id, entry);
      if (entry.delivery?.status === "pending") {
        keys.add(entry.childSessionKey);
      }
    }
    for (const entry of [...rows.values()].slice(-60)) {
      const active: SubagentRunRecord = {
        ...entry,
        execution: { status: "running", startedAt: teamShape.summary.now },
        completion: { required: true },
        delivery: { status: "pending" },
        cleanupCompletedAt: undefined,
      };
      rows.set(entry.runId, active);
      keys.add(entry.childSessionKey);
      const claim = agentRuns.claimAgentRunContext(
        entry.runId,
        {
          sessionKey: entry.childSessionKey,
          sessionId: entry.childSessionIdentity?.sessionId,
          agentId: "main",
        },
        { trackOwner: true, ownsContext: true },
      );
      assert.ok(claim);
      claims.set(entry.runId, claim);
    }
    // Persist the same canonical rows used by resident reads before worker snapshots load.
    fixture.saveSubagentRegistryToSqlite(rows);
    for (const entry of rows.values()) {
      subagentRuns.set(
        entry.runId,
        flow === "maintenance" || claims.has(entry.runId)
          ? entry
          : compactSubagentRunForMemory(entry),
      );
    }
    expected = [...keys].toSorted();
  } else {
    fixture.saveSubagentRegistryToSqlite(rows);
    expected = Array.from({ length: 60 }, (_, i) => childKey(i)).toSorted();
  }
  prepared = await prepareSessionMaintenancePreservation(path.join(stateDir, "sessions.json"));
  assert.deepEqual(prepared.capture().providerKeys, expected);

  if (!teamShape) {
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
    expected = [
      ...Array.from({ length: 57 }, (_, index) => childKey(index + 3)),
      childKey(60),
      childKey(61),
      childKey(runCount),
    ].toSorted();
    assert.deepEqual(prepared.capture().providerKeys, expected);
    assert.deepEqual(prepared.refreshCandidates([childKey(61)]).providerKeys, expected);
  }

  const activeIds = [...claims.keys()];
  const replaceActive = async (ordinal: number) => {
    const id = activeIds[ordinal % activeIds.length]!;
    await persistence.mutateSubagentRuns([id], (current) => {
      const entry = current.get(id)!;
      assert.equal(entry.execution.status, "running");
      return {
        value: undefined,
        postimages: new Map([
          [
            id,
            {
              ...entry,
              delivery: {
                ...entry.delivery,
                status: "pending" as const,
                attemptCount: ordinal + 1,
              },
            },
          ],
        ]),
      };
    });
  };
  if (mutateEvery) {
    await replaceActive(0);
    assert.deepEqual(prepared.capture().providerKeys, expected);
  }

  const parents = teamShape
    ? [...new Set([...claims.keys()].map((id) => rows.get(id)!.requesterSessionKey))].toSorted()
    : [];
  const logicalNow = teamShape?.summary.now;
  type ReadOutput = string[] | string | undefined | ControlledSubagentRunsReadContext;
  const read = async (ordinal: number): Promise<ReadOutput> => {
    const controllerSessionKey = parents[ordinal % parents.length]!;
    const actualNow = Date.now;
    // Only logical read time is fixed; pacing, mutation and performance clocks stay real.
    Date.now = () => logicalNow!;
    try {
      return flow === "prompt"
        ? await buildActiveSubagentRuntimeContext({ cfg, controllerSessionKey })
        : await buildControlledSubagentRunsReadContext(controllerSessionKey, "main", cfg);
    } finally {
      Date.now = actualNow;
    }
  };
  const capture = (ordinal = 0) =>
    flow === "maintenance" ? prepared!.capture().providerKeys : read(ordinal);
  const outputCount = (output: ReadOutput) =>
    typeof output === "string" || Array.isArray(output)
      ? output.length
      : (output?.runs.length ?? 0);
  const summarize = (output: ReadOutput) => ({
    count: outputCount(output),
    sha256: hash(
      "sha256",
      JSON.stringify(output, (key, value: unknown) => {
        // Mutations intentionally change this counter without changing read semantics.
        if (key === "attemptCount") {
          return undefined;
        }
        return value instanceof Map
          ? [...value.entries()].toSorted(([a], [b]) => String(a).localeCompare(String(b)))
          : value;
      })?.replaceAll(stateDir, "<fixture>") ?? "undefined",
      "hex",
    ),
  });
  const expectedOutputs = [];
  for (let index = 0; index < (flow === "maintenance" ? 1 : parents.length); index++) {
    const output = await capture(index);
    const summary = summarize(output);
    assert.ok(
      summary.count > 0,
      `${flow} returned no output for ${parents[index] ?? "maintenance"}`,
    );
    expectedOutputs.push(summary);
  }
  const contextCounts = [];
  if (flow !== "maintenance") {
    for (const [index, parent] of parents.entries()) {
      const actualNow = Date.now;
      Date.now = () => logicalNow!;
      let context: ControlledSubagentRunsReadContext;
      try {
        context = await buildControlledSubagentRunsReadContext(parent, "main", cfg);
      } finally {
        Date.now = actualNow;
      }
      const parentRows = [...rows.values()].filter((entry) => entry.requesterSessionKey === parent);
      contextCounts.push({
        parent,
        retainedRuns: parentRows.length,
        childSessions: new Set(parentRows.map((entry) => entry.childSessionKey)).size,
        activeClaims: parentRows.filter((entry) => claims.has(entry.runId)).length,
        controlledRuns: context.runs.length,
        active: context.list.view.active.length,
        recent: context.list.view.recent.length,
        execution: context.list.execution.size,
        pendingDescendants: context.list.pendingDescendants.size,
        childSessionControllers: context.list.childSessionsByController.size,
        output: expectedOutputs[index],
      });
    }
  }

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
    await capture();
  } finally {
    probe.mock.restore();
    probe.mock.resetCalls();
  }
  for (let index = 0; index < 100; index++) {
    await capture(index);
  }
  global.gc();
  await nextTurn();
  inspector.connect();
  loop.enable();
  await delay(10);
  writeSync(1, `CAPTURE_READY ${JSON.stringify({ pid: process.pid, stateDir, startAt })}\n`);
  if (values["start-file"]) {
    while (!existsSync(values["start-file"])) {
      await delay(100);
    }
    startAt = Number(readFileSync(values["start-file"], "utf8"));
    assert.ok(Number.isSafeInteger(startAt) && startAt > Date.now(), "Invalid shared start time");
  }
  if (startAt) {
    assert.ok(Date.now() < startAt, "Missed --start-at after setup and warmup");
    await delay(startAt - Date.now());
  }
  const latency: number[] = [];
  observer.observe({ entryTypes: ["gc"] });
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  loop.reset();
  marker("heap-start");
  measuredStart = performance.now();
  let checksum = 0;
  let expectedChecksum = 0;
  let mutations = 0;
  for (let index = 0; index < operations; index++) {
    const started = performance.now();
    if (mutateEvery && (index + 1) % mutateEvery === 0) {
      await replaceActive(++mutations);
    }
    const output = flow === "maintenance" ? prepared.capture().providerKeys : await read(index);
    latency.push(performance.now() - started);
    checksum += outputCount(output);
    expectedChecksum += expectedOutputs[index % expectedOutputs.length]!.count;
    if (intervalMs) {
      await delay(Math.max(0, measuredStart + (index + 1) * intervalMs - performance.now()));
    } else {
      await (yieldMs ? delay(yieldMs) : nextTurn());
    }
  }
  measuredEnd = performance.now();
  const usedCpu = process.cpuUsage(cpu);
  const usedThreadCpu = process.threadCpuUsage(threadCpu);
  const after = process.memoryUsage();
  marker("heap-stop");
  loop.disable();
  await nextTurn();
  recordGc(observer.takeRecords());
  observer.disconnect();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  assert.equal(checksum, expectedChecksum);
  assert.deepEqual(prepared.capture().providerKeys, expected);
  for (let index = 0; index < expectedOutputs.length; index++) {
    assert.deepEqual(summarize(await capture(index)), expectedOutputs[index]);
  }
  if (profile) {
    writeFileSync(profilePath, JSON.stringify(profile));
  }
  const gc = (kind?: number) =>
    distribution(
      collections
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map((entry) => entry.ms),
    );
  const totalGc = gc();
  const allocations = profile ? allocation(profile) : undefined;
  const promotion = values["gc-log"]
    ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
    : undefined;
  const result = {
    scope: `production ${flow} read; no RPC latency claim`,
    flow,
    topology: values["concentrated-root"] ? "concentrated-root stress" : "distributed",
    logicalNow,
    outputCountUnit: flow === "prompt" ? "characters" : flow === "control" ? "runs" : "keys",
    outputs: expectedOutputs,
    outputsSha256: hash("sha256", JSON.stringify(expectedOutputs), "hex"),
    contextCounts,
    node: process.version,
    runCount,
    teamShape: teamShape?.summary,
    activeRuns: claims.size,
    residentPayloadEvictedRuns: [...subagentRuns.values()].filter(isSubagentRunPayloadEvicted)
      .length,
    mutateEvery,
    mutations,
    operations,
    yieldMs,
    intervalMs,
    projectedCapturesPerMinute: perMinute,
    startAt,
    stateDir,
    profilePath,
    protectedKeys: expected.length,
    protectedKeysSha256: hash("sha256", JSON.stringify(expected), "hex"),
    registryMapRowWritesPerCapture: rowWrites,
    allocation: allocations
      ? {
          ...allocations,
          projectedBytesPerMinute: allocations.bytesPerOperation * perMinute,
        }
      : null,
    profiled: values.allocations,
    latencyScope: mutateEvery
      ? `${flow} read and periodic committed run replacement`
      : `${flow} read`,
    captureLatency: distribution(latency),
    elapsedMs: measuredEnd - measuredStart,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    threadCpuMs: (usedThreadCpu.user + usedThreadCpu.system) / 1000,
    cpuMsPerCapture: (usedCpu.user + usedCpu.system) / 1000 / operations,
    projectedCpuMsPerMinute: ((usedCpu.user + usedCpu.system) / 1000 / operations) * perMinute,
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
  for (const [id, claim] of claims) {
    agentRuns.releaseAgentRunContext(id, claim);
  }
  await database.closeOpenClawStateDatabaseAsync();
}
