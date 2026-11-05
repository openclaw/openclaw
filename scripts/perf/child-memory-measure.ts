// Source-owner measurement; fixtures use real Linux procfs and worker-spawned descendants.
// node --import ./scripts/tsx.mjs scripts/perf/child-memory-measure.ts --owner <module> --seconds 120 --output <json>
// Pair baseline/candidate on interleaved CPUs, then swap placement. Run --allocations
// and --work-counts separately: their instrumentation is not timing-gate evidence.
// On Node 26, --work-counts --assert-promise-budget checks promises per native read job.
// Legacy per-command timer owners: --sample-delay-ms 1 --seconds 30 accelerates owner polling.
// Shared deadline samplers require real timers; accelerated mode rejects them.
// Legacy accelerated polling reports CPU/allocation
// per completed sample. It is not enforcement-latency evidence; run runaway proof separately.
// For crossover runs, start child-memory-fixture.cjs forest 20 9 <roots.json> once,
// then use --roots <roots.json> --trees 20 --watched 1|2|4|8|12|20 against each owner.
// --trees 1 --descendants 9 measures an unchanged ten-process tree. All descendants
// originate on nonleader threads; normal Node threads remain in every process.
// --max-allocation-bytes-per-sample <bytes> asserts a measured V8 allocation
// budget with --sample-delay-ms; use the same fixture/runtime for base and head.
import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";
import { writeGatewayGcTraceMarker, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    trees: { type: "string", default: "20" },
    watched: { type: "string" },
    roots: { type: "string" },
    descendants: { type: "string", default: "2" },
    seconds: { type: "string", default: "60" },
    "warmup-seconds": { type: "string", default: "5" },
    "sample-delay-ms": { type: "string" },
    "start-file": { type: "string" },
    "gc-log": { type: "string" },
    allocations: { type: "boolean", default: false },
    "work-counts": { type: "boolean", default: false },
    "assert-promise-budget": { type: "boolean", default: false },
    "max-allocation-bytes-per-sample": { type: "string" },
    runaway: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert.equal(process.platform, "linux");
assert.ok(values.output, "--output is required");
assert.ok(!(values.allocations && values["gc-log"]), "Profile allocation and promotion separately");
assert.ok(
  !values["work-counts"] || (!values.allocations && !values["gc-log"]),
  "Count async resources separately from allocation and promotion profiles",
);
assert.ok(
  !values["assert-promise-budget"] || values["work-counts"],
  "--assert-promise-budget requires --work-counts",
);
const integer = (name: "trees" | "descendants" | "seconds", min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const trees = integer("trees", 1);
const descendants = integer("descendants", 1);
const watched = parseStrictIntegerOption({
  raw: values.watched,
  label: "--watched",
  min: 1,
  fallback: trees,
});
assert.ok(watched <= trees, "--watched cannot exceed --trees");
assert.ok(!values.runaway || watched === trees, "--runaway requires every tree to be watched");
const roots: unknown = values.roots ? JSON.parse(fs.readFileSync(values.roots, "utf8")) : undefined;
assert.ok(
  roots === undefined ||
    (Array.isArray(roots) &&
      roots.length === trees &&
      roots.every((pid) => Number.isSafeInteger(pid) && pid > 0)),
  "--roots must contain one positive PID per tree",
);
assert.ok(!values.runaway || !roots, "--runaway requires owned fixtures");
assert.ok(!values.runaway || descendants === 2, "--runaway requires --descendants 2");
const seconds = integer("seconds", 1);
const warmupSeconds = parseStrictIntegerOption({
  raw: values["warmup-seconds"],
  label: "--warmup-seconds",
  min: 1,
  fallback: 5,
});
const sampleDelayMs = values["sample-delay-ms"]
  ? parseStrictIntegerOption({
      raw: values["sample-delay-ms"],
      label: "--sample-delay-ms",
      min: 1,
      fallback: 1,
    })
  : undefined;
assert.ok(!sampleDelayMs || !values.runaway, "Run runaway proof with the real sampling intervals");
const allocationBudget = values["max-allocation-bytes-per-sample"]
  ? parseStrictIntegerOption({
      raw: values["max-allocation-bytes-per-sample"],
      label: "--max-allocation-bytes-per-sample",
      min: 1,
      fallback: 1,
    })
  : undefined;
assert.ok(
  !allocationBudget || sampleDelayMs,
  "--max-allocation-bytes-per-sample requires --sample-delay-ms",
);
const outputPath = path.resolve(values.output);
const profilePath = `${outputPath}.heapprofile`;
const fixture = fileURLToPath(new URL("./child-memory-fixture.cjs", import.meta.url));
const { watchChildMemory }: typeof import("../../src/process/child-memory.js") = await import(
  values.owner
    ? pathToFileURL(path.resolve(values.owner)).href
    : "../../src/process/child-memory.js"
);
if (values["gc-log"]) {
  assert.ok(global.gc, "Trace mode requires --expose-gc");
  writeGatewayGcTraceMarker("identify-start", profilePath);
  global.gc();
  writeGatewayGcTraceMarker("identify-stop", profilePath);
}

function allocated(profile: HeapProfiler.SamplingHeapProfile) {
  let bytes = 0;
  let ownerBytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, owner = false) => {
    const inOwner =
      owner ||
      (node.callFrame.url.includes("child-memory") &&
        !node.callFrame.url.includes("child-memory-measure"));
    bytes += node.selfSize;
    if (inOwner) {
      ownerBytes += node.selfSize;
    }
    node.children.forEach((child) => visit(child, inOwner));
  };
  visit(profile.head);
  return {
    scope: "sampled V8 heap allocation; external Buffer storage excluded",
    bytes,
    ownerBytes,
    bytesPerSecond: bytes / seconds,
    ownerBytesPerSecond: ownerBytes / seconds,
  };
}

const watcherContext = new AsyncLocalStorage<boolean>();
const originalSetTimeout = globalThis.setTimeout;
let capturingSamples = false;
let completedSamples = 0;
const requestedIntervals: Record<string, number> = {};
if (sampleDelayMs) {
  globalThis.setTimeout = Object.assign((...args: Parameters<typeof setTimeout>) => {
    if (watcherContext.getStore()) {
      assert.ok(args[1] === 1000 || args[1] === 5000, "Unexpected watcher interval");
      if (capturingSamples) {
        completedSamples++;
        requestedIntervals[args[1]] = (requestedIntervals[args[1]] ?? 0) + 1;
      }
      args[1] = sampleDelayMs;
    }
    return originalSetTimeout(...args);
  }, originalSetTimeout);
}

const children: ChildProcess[] = [];
const stops: Array<() => void> = [];
const inspector = new Session();
let failure: Error | undefined;
let bursting = false;
let burstAt = 0;
let killedAt = 0;
let killDiagnostic = "";
let diagnosticsStop: ReturnType<typeof startGatewayBenchDiagnostics> | undefined;
const asyncResources: Record<string, number> = {};
const resourceHook = values["work-counts"]
  ? createHook({
      init(_id, type) {
        asyncResources[type] = (asyncResources[type] ?? 0) + 1;
      },
    })
  : undefined;
try {
  // Prepare each identical tree sequentially. Setup allocation is outside capture.
  for (let index = 0; index < trees; index++) {
    const child = roots
      ? undefined
      : spawn(process.execPath, [fixture, String(descendants)], {
          detached: true,
          stdio: ["pipe", "pipe", "inherit"],
        });
    if (child) {
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("Fixture readiness timed out")), 30_000);
        const onExit = () => reject(new Error("Fixture exited during setup"));
        child.once("error", reject);
        child.once("exit", onExit);
        child.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (bursting && index === trees - 1) {
            const burst = /\{"event":"burst","at":(\d+)\}/.exec(output);
            if (burst) {
              burstAt = Number(burst[1]);
            }
          }
          if (output.includes('"ready"')) {
            clearTimeout(timeout);
            child.removeListener("exit", onExit);
            resolve();
          }
        });
      });
      child.on("exit", () => {
        if (bursting && index === trees - 1) {
          killedAt = Date.now();
        } else {
          failure ??= new Error("Fixture exited during measurement");
        }
      });
    }
    const pid: number | undefined = Array.isArray(roots) ? roots[index] : child?.pid;
    const startWatch = () =>
      watchChildMemory({
        pid,
        limitBytes: Math.max(768, (descendants + 1) * 128) * 1024 ** 2,
        onLimit: () => {
          if (bursting && index === trees - 1) {
            process.kill(-pid!, "SIGKILL");
          } else {
            failure ??= new Error("Idle fixture exceeded its memory bound");
          }
        },
        onDiagnostic: (text) => {
          if (bursting && index === trees - 1) {
            killDiagnostic += text;
          } else {
            failure ??= new Error(text);
          }
        },
      });
    if (index < watched) {
      // Supervisor callers carry request context in both benchmark arms.
      stops.push(watcherContext.run(true, startWatch));
    }
  }
  await delay(warmupSeconds * 1000);
  fs.writeSync(
    1,
    `PHASE warmed ${JSON.stringify({ pid: process.pid, trees, ageSeconds: process.uptime() })}\n`,
  );
  if (values["start-file"]) {
    while (!fs.existsSync(values["start-file"])) {
      await delay(50);
    }
    const start = Number(fs.readFileSync(values["start-file"], "utf8"));
    assert.ok(Number.isFinite(start) && Date.now() < start, "Missed common warm-start deadline");
    await delay(start - Date.now());
  }
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  diagnosticsStop = startGatewayBenchDiagnostics();
  const hostLoadBefore = os.loadavg();
  const memoryBefore = process.memoryUsage();
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  const threadCpuStart = process.threadCpuUsage();
  const cpuStart = process.cpuUsage();
  resourceHook?.enable();
  writeGatewayGcTraceMarker("heap-start", profilePath);
  capturingSamples = true;
  await delay(seconds * 1000);
  capturingSamples = false;
  writeGatewayGcTraceMarker("heap-stop", profilePath);
  resourceHook?.disable();
  const cpu = process.cpuUsage(cpuStart);
  const threadCpu = process.threadCpuUsage(threadCpuStart);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  const memoryAfter = process.memoryUsage();
  const hostLoadAfter = os.loadavg();
  const diagnostics = diagnosticsStop();
  diagnosticsStop = undefined;
  let allocation: ReturnType<typeof allocated> | null = null;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    fs.writeFileSync(profilePath, JSON.stringify(profile));
    allocation = allocated(profile);
  }
  if (Array.isArray(roots)) {
    for (const pid of roots) {
      process.kill(pid, 0);
    }
  }
  assert.equal(failure, undefined);
  assert.ok(
    !sampleDelayMs || completedSamples > 0,
    "Accelerated sampling needs legacy per-command timers; omit --sample-delay-ms for shared samplers",
  );
  const result = {
    scope: "watchChildMemory with real procfs and worker-spawned descendants",
    timingGateEligible:
      !sampleDelayMs && !values.allocations && !values["gc-log"] && !values["work-counts"],
    acceleratedSampling: sampleDelayMs
      ? {
          unit: "legacy per-command sample completions",
          delayMs: sampleDelayMs,
          completedSamples,
          requestedIntervals,
          cpuMsPerSample: (cpu.user + cpu.system) / 1000 / completedSamples,
          mainThreadCpuMsPerSample: (threadCpu.user + threadCpu.system) / 1000 / completedSamples,
          v8AllocationBytesPerSample: allocatedBytes / completedSamples,
        }
      : null,
    trees,
    watched,
    descendantsPerTree: descendants,
    processesPerTree: descendants + 1,
    seconds,
    warmupSeconds,
    treeSeconds: trees * seconds,
    allocation,
    cpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
    v8AllocationBytes: allocatedBytes,
    v8AllocationBytesPerSecond: allocatedBytes / seconds,
    memory: { before: memoryBefore, after: memoryAfter },
    hostLoad: { before: hostLoadBefore, after: hostLoadAfter },
    asyncResources: values["work-counts"] ? asyncResources : null,
    diagnostics,
    promotion: values["gc-log"]
      ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
      : null,
  };
  if (values.runaway) {
    const runaway = children.at(-1)!;
    const exit = once(runaway, "exit", { signal: AbortSignal.timeout(10_000) });
    bursting = true;
    runaway.stdin!.write("burst\n");
    await exit;
    assert.ok(burstAt && killedAt, "Runaway request was not observed and killed within 10 seconds");
    assert.match(killDiagnostic, /Command killed for exceeding its host memory bound/);
    const kill = {
      concurrentTrees: trees,
      scope: "allocation request to root exit, including page touching",
      latencyMs: killedAt - burstAt,
      diagnostic: killDiagnostic,
    };
    fs.writeFileSync(`${outputPath}.concurrent-kill.json`, `${JSON.stringify(kill, null, 2)}\n`);
    fs.writeSync(1, `CONCURRENT_KILL ${JSON.stringify(kill)}\n`);
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeSync(1, `${JSON.stringify(result)}\n`);
  if (values["assert-promise-budget"]) {
    const readJobs = asyncResources.FSREQCALLBACK ?? 0;
    assert.ok(
      readJobs > 0,
      "No filesystem polling observed; increase --seconds to capture a sample",
    );
    assert.ok(
      (asyncResources.PROMISE ?? 0) <= 4 * readJobs,
      "Child-memory polling exceeded four promises per native read job",
    );
  }
  if (allocationBudget) {
    assert.ok(
      allocatedBytes / completedSamples <= allocationBudget,
      `Child-memory polling exceeded ${allocationBudget} V8 allocated bytes per warm sample`,
    );
  }
} finally {
  globalThis.setTimeout = originalSetTimeout;
  watcherContext.disable();
  resourceHook?.disable();
  diagnosticsStop?.();
  stops.forEach((stop) => stop());
  inspector.disconnect();
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          process.stderr.write(`Fixture cleanup failed: ${String(error)}\n`);
          process.exitCode = 1;
        }
      }
    }
  }
  await Promise.all(
    children.map((child) =>
      !child.pid || child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
          }),
    ),
  );
}
