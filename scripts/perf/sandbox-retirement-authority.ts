/**
 * Measure the real sandbox retirement authority with worker-backed registry state.
 * Each cycle checks one container and one browser four times, matching the normal
 * quiesce/resume lifecycle. Unrelated registered runtimes remain in the database.
 * This isolates authority cost; it does not measure Docker or Gateway latency.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sandbox-retirement-authority.ts \
 *   --output .local/sandbox-authority/base-timing --iterations 2000
 * Add --mode allocation for a separate sampled-allocation pass, including collected
 * objects. Never compare allocation-pass timings against untraced timing passes.
 * Run this same script in each revision, counterbalancing base/candidate order.
 * --registry-module selects a baseline registry module placed beside its original
 * dependencies when those dependencies are unchanged by the measured operation.
 * --output must be new; temporary synthetic state is removed after worker close.
 *
 * --operation workspace-selection measures the two worker-backed registry reads
 * used by readLocalWorkspaceRuntimes, then selects the exact workspace. The default
 * fixture has 256 containers and 64 browsers across 40 agents. An older registry
 * module ignores workspaceDir and returns the whole fleet; the caller filter keeps
 * selected results identical. Reported rows count the decoded/transferred entries,
 * not SQLite pages scanned. This excludes persistent streams, custody acquisition,
 * filesystem synchronization, Docker latency, and full Gateway startup. The registry
 * owner issues no Git commands or child-process operations; database I/O is included
 * in elapsed/CPU measurements but filesystem syscall counts are not instrumented.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    mode: { type: "string", default: "timing" },
    operation: { type: "string", default: "retirement-authority" },
    iterations: { type: "string", default: "2000" },
    containers: { type: "string", default: "256" },
    browsers: { type: "string", default: "64" },
    agents: { type: "string", default: "40" },
    "registry-module": { type: "string" },
  },
});
assert(values.output, "--output is required");
assert(values.mode === "timing" || values.mode === "allocation", "Invalid --mode");
assert(
  values.operation === "retirement-authority" || values.operation === "workspace-selection",
  "Invalid --operation",
);
assert(global.gc, "Run with --expose-gc");
assert(!process.execArgv.some((arg) => arg.startsWith("--trace-gc")), "Use untraced runs");
const integer = (label: "iterations" | "containers" | "browsers" | "agents", fallback: number) =>
  parseStrictIntegerOption({ raw: values[label], label: `--${label}`, min: 1, fallback });
const iterations = integer("iterations", 2000);
const containers = integer("containers", 256);
const browsers = integer("browsers", 64);
const agents = integer("agents", 40);
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const stateDir = await mkdtemp(path.join(output, "synthetic-state-"));
const configPath = path.join(stateDir, "openclaw.json");
await mkdir(path.join(stateDir, "home"));
await mkdir(path.join(stateDir, "tmp"));
await writeFile(configPath, JSON.stringify({ plugins: { enabled: false } }));
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};

const registryModuleUrl = values["registry-module"]
  ? pathToFileURL(path.resolve(values["registry-module"]))
  : new URL("../../src/agents/sandbox/registry.ts", import.meta.url);
const registry: typeof import("../../src/agents/sandbox/registry.js") = await import(
  registryModuleUrl.href
);
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { resolveOpenClawStateSqlitePath } =
  await import("../../src/state/openclaw-state-db.paths.js");
const database = { path: resolveOpenClawStateSqlitePath(), env: process.env };
const inspector = new Session();
const collections: Array<{ startTime: number; duration: number; kind: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as { detail?: { kind?: number } }).detail;
    collections.push({
      startTime: entry.startTime,
      duration: entry.duration,
      kind: detail?.kind ?? 0,
    });
  }
});
const entry = (index: number) => ({
  containerName: `synthetic-runtime-${index}`,
  backendId: "docker",
  sessionKey: `agent:synthetic-${index % agents}:synthetic-${index}`,
  workspaceDir: path.join(stateDir, "projections", String(index)),
  createdAtMs: 1_800_000_000_000,
  lastUsedAtMs: 1_800_000_000_001,
  image: "synthetic-sandbox:fixture",
  configHash: `synthetic-configuration-${index}`,
});
let memoryTimer: ReturnType<typeof setInterval> | undefined;
try {
  for (let index = 0; index < containers; index++) {
    await registry.updateRegistry(entry(index));
  }
  for (let index = 0; index < browsers; index++) {
    await registry.updateBrowserRegistry({
      ...entry(index),
      containerName: `synthetic-browser-${index}`,
      cdpPort: 41000 + index,
    });
  }
  const container = (await registry.readRegistry(database)).entries[0];
  const browser = (await registry.readBrowserRegistry(database)).entries[0];
  assert(container && browser, "Registry fixtures were not published");
  const authorityCycle = async () => {
    for (let check = 0; check < 4; check++) {
      await registry.assertSandboxRegistryRetirementCurrent("container", container, database);
      await registry.assertSandboxRegistryRetirementCurrent("browser", browser, database);
    }
  };
  const workspaceDir = entry(0).workspaceDir;
  let returnedRows = 0;
  const selectionCycle = async () => {
    const options = { ...database, workspaceDir };
    const [selectedContainers, selectedBrowsers] = await Promise.all([
      registry.readRegistry(options),
      registry.readBrowserRegistry(options),
    ]);
    returnedRows += selectedContainers.entries.length + selectedBrowsers.entries.length;
    const containersInWorkspace = selectedContainers.entries.filter(
      (selected) => selected.workspaceDir === workspaceDir,
    );
    const browsersInWorkspace = selectedBrowsers.entries.filter(
      (selected) => selected.workspaceDir === workspaceDir,
    );
    assert.equal(containersInWorkspace.length, 1);
    assert.equal(containersInWorkspace[0]?.containerName, "synthetic-runtime-0");
    assert.equal(browsersInWorkspace.length, 1);
    assert.equal(browsersInWorkspace[0]?.containerName, "synthetic-browser-0");
  };
  const cycle = values.operation === "workspace-selection" ? selectionCycle : authorityCycle;
  const warmup = 25;
  for (let index = 0; index < warmup; index++) {
    await cycle();
  }
  returnedRows = 0;
  global.gc();
  await nextTurn();
  await nextTurn();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const loadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const peakMemory = { rss: memoryBefore.rss, heapUsed: memoryBefore.heapUsed };
  const sampleMemory = () => {
    const memory = process.memoryUsage();
    peakMemory.rss = Math.max(peakMemory.rss, memory.rss);
    peakMemory.heapUsed = Math.max(peakMemory.heapUsed, memory.heapUsed);
  };
  memoryTimer = setInterval(sampleMemory, 100);
  const cpuBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const cycleDurationsMs: number[] = [];
  const startTime = performance.now();
  for (let index = 0; index < iterations; index++) {
    const cycleStart = performance.now();
    await cycle();
    cycleDurationsMs.push(performance.now() - cycleStart);
  }
  const endTime = performance.now();
  const cpu = process.cpuUsage(cpuBefore);
  const threadCpu = process.threadCpuUsage(threadBefore);
  clearInterval(memoryTimer);
  sampleMemory();
  const memoryAfter = process.memoryUsage();
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  await nextTurn();
  await nextTurn();
  const gc = collections.filter(
    (collection) => collection.startTime >= startTime && collection.startTime < endTime,
  );
  const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
  const allocationBytes = profile ? sampledBytes(profile.head) : undefined;
  const wallMs = endTime - startTime;
  const sourceHashes: Record<string, string> = {};
  for (const module of ["registry.ts", "registry-currentness.ts", "registry.kernel.ts"]) {
    sourceHashes[module] = createHash("sha256")
      .update(
        await readFile(
          module === "registry.ts"
            ? registryModuleUrl
            : new URL(`../../src/agents/sandbox/${module}`, import.meta.url),
        ),
      )
      .digest("hex");
  }
  cycleDurationsMs.sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    cycleDurationsMs[Math.min(iterations - 1, Math.ceil(iterations * fraction) - 1)];
  const report = {
    scope:
      values.operation === "workspace-selection"
        ? "Registry portion of workspace selection: container and browser reads, exact workspace filter"
        : "Real retirement authority: four checks each for a container and browser per cycle",
    operation: values.operation,
    mode: values.mode,
    node: process.version,
    registryModule: registryModuleUrl.href,
    sourceHashes,
    iterations,
    checks: values.operation === "retirement-authority" ? iterations * 8 : undefined,
    work:
      values.operation === "workspace-selection"
        ? {
            registryReads: iterations * 2,
            returnedRows,
            returnedRowsPerCycle: returnedRows / iterations,
            selectedRowsPerCycle: 2,
          }
        : undefined,
    warmup,
    fixture: { containers, browsers, agents },
    hostLoad: { before: loadBefore, after: loadavg() },
    wallMs,
    wallUsPerCycle: (wallMs * 1000) / iterations,
    cycleWallMs: {
      samples: iterations,
      min: cycleDurationsMs[0],
      median: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: cycleDurationsMs.at(-1),
    },
    processCpuMs: (cpu.user + cpu.system) / 1000,
    processCpuUsPerCycle: (cpu.user + cpu.system) / iterations,
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
    mainThreadCpuUsPerCycle: (threadCpu.user + threadCpu.system) / iterations,
    memory: {
      before: memoryBefore,
      after: memoryAfter,
      sampledPeak: peakMemory,
      sampleIntervalMs: 100,
    },
    gc: {
      scope: "main thread",
      count: gc.length,
      totalMs: gc.reduce((sum, collection) => sum + collection.duration, 0),
      maxPauseMs: gc.reduce((max, collection) => Math.max(max, collection.duration), 0),
      byKind: Object.fromEntries(
        [...new Set(gc.map((collection) => collection.kind))].map((kind) => {
          const selected = gc.filter((collection) => collection.kind === kind);
          return [
            kind,
            {
              count: selected.length,
              totalMs: selected.reduce((sum, collection) => sum + collection.duration, 0),
              maxPauseMs: selected.reduce(
                (max, collection) => Math.max(max, collection.duration),
                0,
              ),
            },
          ];
        }),
      ),
    },
    allocation:
      allocationBytes === undefined
        ? null
        : {
            mainThreadSampledBytes: allocationBytes,
            mainThreadBytesPerCycle: allocationBytes / iterations,
            mainThreadBytesPerSecond: allocationBytes / (wallMs / 1000),
          },
  };
  if (profile) {
    await writeFile(path.join(output, "allocation.heapprofile"), JSON.stringify(profile));
  }
  await writeFile(path.join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  clearInterval(memoryTimer);
  observer.disconnect();
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
  await rm(stateDir, { recursive: true, force: true });
}
