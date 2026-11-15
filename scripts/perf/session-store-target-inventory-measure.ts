/**
 * Measure full inventory preparation with 40 configured agents and alternating
 * one/two-agent requests. Physical candidate capture remains in the workload.
 * This measures the owner, not Gateway throughput or production call frequency.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-store-target-inventory-measure.ts \
 *   --state-dir /absolute/fresh/synthetic-state --mode timing --iterations 3000
 * Repeat with --mode allocation for a separate sampled-allocation pass including
 * collected objects. Compare counterbalanced base/candidate runs; never compare
 * allocation-instrumented CPU with untraced CPU. --output saves the JSON report.
 * --owner accepts a saved owner module whose relative imports resolve normally.
 * The required state directory must not exist; this script creates and removes it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    owner: { type: "string" },
    output: { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir is required and must name a fresh directory");
assert(["timing", "allocation"].includes(values.mode), "--mode must be timing or allocation");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 3000,
});
const stateDir = path.resolve(values["state-dir"]);
await mkdir(stateDir);
const inspector = new Session();
try {
  const home = path.join(stateDir, "home");
  const tmp = path.join(stateDir, "tmp");
  await mkdir(home);
  await mkdir(tmp);
  process.env = {
    ...createGatewayBenchEnv(home, path.join(stateDir, "openclaw.json"), {
      startupTrace: false,
    }),
    OPENCLAW_STATE_DIR: stateDir,
    TMPDIR: tmp,
  };
  const agentIds = Array.from({ length: 40 }, (_, index) => `agent-${index}`);
  const cfg: OpenClawConfig = {
    agents: { entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])) },
    plugins: { enabled: false },
  };
  for (const agentId of agentIds) {
    const agentDir = path.join(stateDir, "agents", agentId, "agent");
    await mkdir(agentDir, { recursive: true });
    await mkdir(path.join(stateDir, "agents", agentId, "sessions"));
    // Preparation only captures locators; it never opens these synthetic files.
    await writeFile(path.join(agentDir, "openclaw-agent.sqlite"), "");
  }
  const ownerUrl = values.owner
    ? pathToFileURL(path.resolve(values.owner))
    : new URL("../../src/config/sessions/session-store-target-inventory.ts", import.meta.url);
  const ownerSha256 = createHash("sha256")
    .update(await readFile(ownerUrl))
    .digest("hex");
  const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
  const owner: typeof import("../../src/config/sessions/session-store-target-inventory.js") =
    await import(ownerUrl.href);
  setRuntimeConfigSnapshot(cfg);
  const requests = agentIds.map((agentId, index) =>
    index % 2 === 0 ? [agentId] : [agentId, agentIds[(index + 1) % agentIds.length]!],
  );
  function run(count: number): number {
    let checksum = 0;
    for (let index = 0; index < count; index++) {
      const inventory = owner.prepareSessionStoreTargetInventory(
        cfg,
        requests[index % requests.length]!,
      );
      checksum += inventory.agentIds.length + inventory.paths.size + inventory.candidates.length;
    }
    return checksum;
  }
  const warmup = 300;
  run(warmup);
  global.gc();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostBefore = { load: loadavg(), freeMemory: freemem(), totalMemory: totalmem() };
  const memoryBefore = process.memoryUsage();
  const cpuStart = process.cpuUsage();
  const threadStart = process.threadCpuUsage?.();
  const start = performance.now();
  const checksum = run(iterations);
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const threadCpu = threadStart && process.threadCpuUsage(threadStart);
  const memoryAfter = process.memoryUsage();
  const hostAfter = { load: loadavg(), freeMemory: freemem(), totalMemory: totalmem() };
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
  const allocationBytes = profile ? sampledBytes(profile.head) : undefined;
  assert.equal(checksum, Math.ceil(iterations / 2) * 42 + Math.floor(iterations / 2) * 44);
  const report = {
    scope: "Full store-target inventory preparation, published config, 40 synthetic agents",
    mode: values.mode,
    node: process.version,
    owner: ownerUrl.href,
    ownerSha256,
    iterations,
    warmup,
    checksum,
    wallMs,
    wallUsPerOperation: (wallMs * 1000) / iterations,
    processCpuUsPerOperation: (cpu.user + cpu.system) / iterations,
    threadCpuUsPerOperation: threadCpu ? (threadCpu.user + threadCpu.system) / iterations : null,
    sampledAllocationBytes: allocationBytes ?? null,
    sampledAllocationBytesPerOperation:
      allocationBytes === undefined ? null : allocationBytes / iterations,
    memory: { before: memoryBefore, after: memoryAfter },
    host: { before: hostBefore, after: hostAfter },
  };
  if (values.output) {
    await writeFile(path.resolve(values.output), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report));
} finally {
  if (values.mode === "allocation") {
    inspector.disconnect();
  }
  await rm(stateDir, { recursive: true, force: true });
}
