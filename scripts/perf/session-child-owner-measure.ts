// In-process owner workload; run with --expose-gc on an approved benchmark host.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { constants, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    parents: { type: "string", default: "48" },
    children: { type: "string", default: "200" },
    updates: { type: "string", default: "8000" },
    warmup: { type: "string", default: "1000" },
    mode: { type: "string", default: "timing" },
  },
});
const integer = (name: "parents" | "children" | "updates" | "warmup") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const parentCount = integer("parents");
const childCount = integer("children");
const updates = integer("updates");
const warmup = integer("warmup");
assert.ok(values["state-dir"], "--state-dir must name a new isolated directory");
assert.ok(values.mode === "timing" || values.mode === "allocation", "Invalid --mode");
const collectGarbage = global.gc;
assert.ok(collectGarbage, "Run with --expose-gc");
const root = path.resolve(values["state-dir"]);
mkdirSync(root, { mode: 0o700 });
mkdirSync(path.join(root, "home"));
const config = path.join(root, "openclaw.json");
writeFileSync(config, JSON.stringify({ plugins: { enabled: false } }));
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), config, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
};
const memory = await import("../../src/agents/subagents/registry/subagent-registry-memory.js");
const registry = await import("../../src/infra/agent-run-registry.js");
const { publishSubagentRunChanges } =
  await import("../../src/agents/subagents/registry/subagent-registry-publication.js");
const { createSubagentSessionListReadIndex } =
  await import("../../src/agents/subagents/registry/subagent-registry-read-index.js");
const { resolveSessionChildOwners } = await import("../../src/gateway/session-utils-core.js");
const now = Date.UTC(2026, 9, 25);
const parentKeys = Array.from({ length: parentCount }, (_, index) => `agent:main:parent-${index}`);
const active: SubagentRunRecord[] = [];
const claims = new Map<string, string>();
const rows: Array<{ key: string; entry: SessionEntry }> = [];
const snapshot = new Map<string, SubagentRunReadRecord>();
for (let parent = 0; parent < parentCount; parent++) {
  for (let child = 0; child < childCount; child++) {
    const runId = `synthetic-${parent}-${child}`;
    const key = `agent:main:subagent:${runId}`;
    const entry: SubagentRunRecord = {
      runId,
      childSessionKey: key,
      childAgentId: "main",
      childSessionIdentity: { sessionId: runId },
      requesterSessionKey: parentKeys[parent]!,
      requesterAgentId: "main",
      requesterDisplayKey: parentKeys[parent]!,
      controllerSessionKey: parentKeys[parent]!,
      task: "Synthetic child-owner work",
      cleanup: "keep",
      generation: 1,
      createdAt: now - 1000,
      execution:
        child === 0
          ? { status: "running", startedAt: now }
          : {
              status: "terminal",
              startedAt: now - 1000,
              endedAt: now - 500,
              outcome: { status: "ok" },
            },
      cleanupCompletedAt: child === 0 ? undefined : now,
      delivery: { status: "not_required" },
    };
    memory.subagentRuns.set(runId, entry);
    snapshot.set(runId, memory.immutableSubagentRunSessionList(entry));
    if (child === 0) {
      active.push(entry);
    }
    if (child < 4) {
      rows.push({
        key,
        entry: {
          sessionId: runId,
          updatedAt: now,
          spawnedBy: parentKeys[parent],
          spawnDepth: 1,
          parentSessionKey: parentKeys[parent],
          ...(child % 3 ? { archivedAt: now } : {}),
        },
      });
    }
  }
}
function claim(entry: SubagentRunRecord, clock: number) {
  const token = registry.claimAgentRunContext(
    entry.runId,
    {
      agentId: "main",
      sessionKey: entry.childSessionKey,
      sessionId: entry.childSessionIdentity?.sessionId,
      lifecycleStartedAt: clock,
      projectSessionActive: true,
      isControlUiVisible: true,
    },
    { trackOwner: true, ownsContext: true },
  );
  assert.ok(token);
  claims.set(entry.runId, token);
}
for (const entry of active) {
  claim(entry, now);
}
const resident = createSubagentSessionListReadIndex(
  {
    snapshotIdentity: () => memory.subagentRuns,
    runs(ids) {
      if (!ids) {
        return snapshot;
      }
      const selected = new Map<string, SubagentRunReadRecord>();
      for (const id of ids) {
        const entry = memory.subagentRuns.get(id);
        if (entry) {
          selected.set(id, memory.immutableSubagentRunSessionList(entry));
        }
      }
      return selected;
    },
    prepare: async () => {},
  },
  now,
);
const lookup = memory.getSubagentSessionReadLookup(memory.subagentRuns);
let previousTopology = lookup.captureTopology();
let topologyChanges = 0;
let checksum = 0;
let sequence = 0;
function updateRun() {
  const index = sequence % parentCount;
  const previous = active[index]!;
  const clock = now + Math.floor((sequence * 1000) / 48);
  const running = Math.floor(sequence / parentCount) % 2 === 0;
  const token = claims.get(previous.runId);
  if (token) {
    registry.releaseAgentRunContext(previous.runId, token);
  }
  claims.delete(previous.runId);
  const entry: SubagentRunRecord = {
    ...previous,
    execution: running
      ? { status: "running", startedAt: clock }
      : { status: "terminal", startedAt: clock - 1000, endedAt: clock, outcome: { status: "ok" } },
    cleanupCompletedAt: running ? undefined : clock,
  };
  memory.subagentRuns.set(entry.runId, entry);
  if (running) {
    claim(entry, clock);
  }
  active[index] = entry;
  publishSubagentRunChanges([entry.childSessionKey], [entry.runId]);
  sequence++;
}
function resolveList() {
  const clock = now + Math.floor((sequence * 1000) / 48);
  const index = resident.read(clock);
  const topology = lookup.captureTopology();
  if (topology !== previousTopology) {
    topologyChanges++;
  }
  previousTopology = topology;
  for (const key of parentKeys) {
    checksum += index.countActiveDescendantRuns(key);
  }
  for (const row of rows) {
    checksum += resolveSessionChildOwners({ ...row, now: clock, subagentRuns: index }).length;
  }
}
async function run(count: number) {
  let completed = 0;
  let lists = 0;
  let updateCpuMicros = 0;
  let resolutionCpuMicros = 0;
  while (completed < count) {
    // 48 updates/s : 1.44 lists/s = 100 updates per three resolution passes.
    const batch = Math.min(count - completed, [33, 33, 34][lists % 3]!);
    let before = process.threadCpuUsage();
    for (let step = 0; step < batch; step++) {
      updateRun();
    }
    let cpu = process.threadCpuUsage(before);
    updateCpuMicros += cpu.user + cpu.system;
    before = process.threadCpuUsage();
    resolveList();
    cpu = process.threadCpuUsage(before);
    resolutionCpuMicros += cpu.user + cpu.system;
    completed += batch;
    lists++;
    await nextTurn();
  }
  return { updates: completed, lists, updateCpuMicros, resolutionCpuMicros };
}
const gcEntries: Array<{ at: number; kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const json: unknown = entry.toJSON();
    const detail = isRecord(json) ? json.detail : undefined;
    assert.ok(isRecord(detail) && typeof detail.kind === "number");
    gcEntries.push({ at: entry.startTime, kind: detail.kind, duration: entry.duration });
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
try {
  await run(warmup);
  collectGarbage();
  await nextTurn();
  await nextTurn();
  gcEntries.length = 0;
  topologyChanges = 0;
  checksum = 0;
  const heapBefore = process.memoryUsage().heapUsed;
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const started = performance.now();
  const before = process.threadCpuUsage();
  const work = await run(updates);
  const cpu = process.threadCpuUsage(before);
  const ended = performance.now();
  await nextTurn();
  await nextTurn();
  let allocatedBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    writeFileSync(path.join(root, "allocation.heapprofile"), JSON.stringify(profile));
    const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + bytes(child), 0);
    allocatedBytes = bytes(profile.head);
  }
  const gc: Record<string, { count: number; totalMs: number }> = {};
  for (const entry of gcEntries) {
    if (entry.at < started || entry.at >= ended) {
      continue;
    }
    const name =
      entry.kind === constants.NODE_PERFORMANCE_GC_MINOR
        ? "minor"
        : entry.kind === constants.NODE_PERFORMANCE_GC_MAJOR
          ? "major"
          : "other";
    const metric = (gc[name] ??= { count: 0, totalMs: 0 });
    metric.count++;
    metric.totalMs += entry.duration;
  }
  const heapAfter = process.memoryUsage().heapUsed;
  collectGarbage();
  const result = {
    mode: values.mode,
    parentCount,
    childCount,
    rows: rows.length,
    ...work,
    wallMs: ended - started,
    threadCpuMs: (cpu.user + cpu.system) / 1000,
    resolutionCpuMsPerList: work.resolutionCpuMicros / 1000 / work.lists,
    updateCpuMsPerUpdate: work.updateCpuMicros / 1000 / work.updates,
    allocatedBytes,
    allocatedBytesPerUpdate:
      allocatedBytes === undefined ? undefined : allocatedBytes / work.updates,
    gc,
    topologyChanges,
    checksum,
    heapBefore,
    heapAfter,
    retainedHeapAfter: process.memoryUsage().heapUsed,
  };
  writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  observer.disconnect();
  inspector.disconnect();
  resident.dispose();
  for (const [id, token] of claims) {
    registry.releaseAgentRunContext(id, token);
  }
  memory.subagentRuns.clear();
}
