/**
 * Synthetic registry owner proof: 5,000 runs, 500 active, 1,000 requester sessions.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-registry-commit-measure.ts \
 *   --output .local/lane2602/a1.json [--source-file .local/lane2602/persistence.base.ts]
 * Repeat A/A/B serially, at least five timing samples per arm; --allocation separates
 * collected-object sampling from timing. --cpu-profile records the measured owner flow.
 * Acceptance: identical persisted/reloaded rows and read digests; lower commit allocation
 * outside A/A spread, with no consistent CPU or read regression. Real registry worker persistence
 * and the resident session-list index are exercised, not Gateway RPC/transport latency.
 * For binding reuse: --mixed --working-set 64 --iterations 2048. The mixed workload
 * alternates metadata writes, no-ops, nested completion writes and equal nested replacements.
 * Both source arms receive identical synchronous-preparation timing instrumentation.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "source-file": { type: "string" },
    allocation: { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    iterations: { type: "string", default: "200" },
    "working-set": { type: "string", default: "5000" },
    mixed: { type: "boolean", default: false },
  },
});
assert(values.output && global.gc, "Pass --output and run with --expose-gc");
const gc = global.gc;
const iterations = Number(values.iterations);
const workingSet = Number(values["working-set"]);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(workingSet) && workingSet > 0 && workingSet <= 5000);
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
process.env.TMPDIR = path.dirname(output);
const owner = new URL(
  "../../src/agents/subagents/registry/subagent-registry-persistence.ts",
  import.meta.url,
);
const source = await readFile(values["source-file"] ?? owner, "utf8");
const memorySourceHash = hash(
  "sha256",
  await readFile(
    new URL("../../src/agents/subagents/registry/subagent-registry-memory.ts", import.meta.url),
  ),
);
const preparation: { wallMs: number; cpuUs: number }[] = [];
process.on("subagent-commit-measure", (wallMs: number, cpuUs: number) => {
  preparation.push({ wallMs, cpuUs });
});
// Measure the synchronous owner boundary separately from worker and publication latency.
const measuredSource = source
  .replace(
    "  const postimages = new Map(",
    `  const measureCpu = process.threadCpuUsage();
  const measureStart = performance.now();
  const postimages = new Map(`,
  )
  .replace(
    "  if (!values.length",
    `  const measureElapsed = performance.now() - measureStart;
  const measureUsed = process.threadCpuUsage(measureCpu);
  process.emit("subagent-commit-measure", measureElapsed, measureUsed.user + measureUsed.system);
  if (!values.length`,
  );
assert.notEqual(measuredSource, source);
assert.equal(source.split("  const postimages = new Map(").length, 2);
assert.equal(source.split("  if (!values.length").length, 2);
let overridden = false;
registerHooks({
  load(url, context, next) {
    if (url === owner.href) {
      overridden = true;
      return {
        format: "module",
        source: transformSync(measuredSource, { loader: "ts", format: "esm", target: "esnext" })
          .code,
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.js");
const { mutateSubagentRuns, restoreSubagentRunsFromDisk } =
  await import("../../src/agents/subagents/registry/subagent-registry-persistence.js");
const { createSubagentSessionListReadView, clearSubagentRunsReadCacheForTest } =
  await import("../../src/agents/subagents/registry/subagent-registry-state.js");
const { createSubagentSessionListReadIndex } =
  await import("../../src/agents/subagents/registry/subagent-registry-read-index.js");
const { saveSubagentRegistryToSqlite, loadSubagentRegistryFromSqlite } =
  await import("../../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
assert(overridden, "Selected owner was not loaded");
const now = 1_800_000_000_000;
const roots = Array.from({ length: 1000 }, (_, i) => `agent:main:requester-${i}`);
const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
const attributedBytes = (node: HeapProfiler.SamplingHeapProfileNode, name: string): number =>
  node.callFrame.functionName === name
    ? bytes(node)
    : node.children.reduce((sum, child) => sum + attributedBytes(child, name), 0);
const digest = (rows: ReadonlyMap<string, SubagentRunRecord>) =>
  hash("sha256", JSON.stringify([...rows].toSorted(([a], [b]) => a.localeCompare(b))));
await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
  const rows = new Map<string, SubagentRunRecord>();
  for (let i = 0; i < 5000; i++) {
    const active = i < 500;
    const runId = `run-${i}`;
    rows.set(runId, {
      runId,
      childSessionKey: `agent:main:subagent:${i}`,
      childAgentId: "main",
      requesterSessionKey: roots[i % roots.length]!,
      requesterDisplayKey: "synthetic",
      createdAt: now - 1000,
      task: `Task ${i}: ${"instructions ".repeat(160)}`,
      cleanup: "keep",
      execution: active
        ? { status: "running", startedAt: now - 1000 }
        : { status: "terminal", endedAt: now - 500 },
      completion: {
        required: !active,
        resultText: `Result ${i}: ${"synthetic result ".repeat(1024)}`,
      },
      delivery: { status: active ? "not_required" : "pending" },
    });
  }
  saveSubagentRegistryToSqlite(rows);
  await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  const sourceView = createSubagentSessionListReadView({ env });
  await sourceView.prepare();
  const reader = createSubagentSessionListReadIndex(sourceView, now);
  const read = () => {
    const index = reader.read(now);
    let count = 0;
    for (const root of roots) {
      count += index.countActiveDescendantRuns(root);
    }
    assert.equal(count, 500);
  };
  const mutate = (i: number) =>
    mutateSubagentRuns([`run-${(i * 23) % workingSet}`], (current) => {
      const row = current.get(`run-${(i * 23) % workingSet}`)!;
      const phase = values.mixed ? Math.floor(i / workingSet) % 4 : 0;
      const next = { ...row };
      if (phase === 0) {
        next.label = `update-${i}`;
      } else if (phase === 2) {
        next.completion = {
          ...row.completion!,
          resultText: `${row.completion!.resultText!.slice(0, 16_000)} result-${i}`,
        };
      } else if (phase === 3) {
        next.completion = { ...row.completion! };
      }
      return {
        value: undefined,
        postimages: new Map([[row.runId, next]]),
      };
    });
  const inspector = new Session();
  inspector.connect();
  const measurements: object[] = [];
  try {
    const warmup = values.mixed ? Math.min(workingSet, 500) : 20;
    for (let i = 0; i < warmup; i++) {
      await mutate(i);
      read();
    }
    for (const flow of ["read", "mutate"] as const) {
      const before = digest(subagentRuns);
      gc();
      const heapBefore = process.memoryUsage().heapUsed;
      preparation.length = 0;
      if (values.allocation) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      if (values["cpu-profile"]) {
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.start");
      }
      const latency: number[] = [];
      const cpuBefore = process.threadCpuUsage();
      const hostLoad = loadavg();
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        if (flow === "read") {
          read();
        } else {
          await mutate(i + warmup);
        }
        latency.push(performance.now() - start);
      }
      const cpu = process.threadCpuUsage(cpuBefore);
      const allocationProfile = values.allocation
        ? (await inspector.post("HeapProfiler.stopSampling")).profile.head
        : undefined;
      const allocation = allocationProfile ? bytes(allocationProfile) / iterations : undefined;
      if (values["cpu-profile"]) {
        await writeFile(
          `${output}.${flow}.cpuprofile`,
          JSON.stringify((await inspector.post("Profiler.stop")).profile),
        );
      }
      latency.sort((a, b) => a - b);
      const ownerTimes = preparation.map((sample) => sample.wallMs).toSorted((a, b) => a - b);
      const ownerCpu = preparation.map((sample) => sample.cpuUs).toSorted((a, b) => a - b);
      if (flow === "read") {
        assert.equal(digest(subagentRuns), before, "Reads changed registry rows");
      }
      // WeakRef targets remain live until the current job ends, even with forced GC.
      await nextTurn();
      gc();
      measurements.push({
        flow,
        cpuUs: (cpu.user + cpu.system) / iterations,
        p50Ms: latency[Math.floor(iterations * 0.5)],
        p95Ms: latency[Math.floor(iterations * 0.95)],
        allocatedBytes: allocation,
        ownerAllocatedBytes: allocationProfile
          ? attributedBytes(allocationProfile, "commitRows") / iterations
          : undefined,
        bindingAllocatedBytes: allocationProfile
          ? attributedBytes(allocationProfile, "bindSubagentRunRecord") / iterations
          : undefined,
        cloneAllocatedBytes: allocationProfile
          ? attributedBytes(allocationProfile, "structuredClone") / iterations
          : undefined,
        hostLoad,
        preparation:
          flow === "mutate"
            ? {
                samples: preparation.length,
                p50Ms: ownerTimes[Math.floor(ownerTimes.length * 0.5)],
                p95Ms: ownerTimes[Math.floor(ownerTimes.length * 0.95)],
                cpuP50Us: ownerCpu[Math.floor(ownerCpu.length * 0.5)],
                cpuP95Us: ownerCpu[Math.floor(ownerCpu.length * 0.95)],
              }
            : undefined,
        heapBefore,
        heapAfter: process.memoryUsage().heapUsed,
        memory: process.memoryUsage(),
      });
    }
    read();
    const committed = digest(loadSubagentRegistryFromSqlite());
    const resident = digest(subagentRuns);
    reader.dispose();
    await closeOpenClawStateDatabaseAsync();
    subagentRuns.clear();
    clearSubagentRunsReadCacheForTest();
    await restoreSubagentRunsFromDisk({ runs: subagentRuns });
    assert.equal(
      digest(loadSubagentRegistryFromSqlite()),
      committed,
      "Reload changed durable rows",
    );
    assert.equal(digest(subagentRuns), resident, "Reload changed resident rows");
    await writeFile(
      output,
      JSON.stringify(
        {
          sourceHash: hash("sha256", source),
          memorySourceHash,
          iterations,
          workingSet,
          mixed: values.mixed,
          runs: 5000,
          active: 500,
          sessions: 1000,
          allocation: values.allocation,
          committed,
          resident,
          measurements,
        },
        null,
        2,
      ),
    );
    console.log(output);
  } finally {
    reader.dispose();
    inspector.disconnect();
    subagentRuns.clear();
    clearSubagentRunsReadCacheForTest();
  }
});
