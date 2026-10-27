// Source-owner measurement; fixtures use real Linux procfs and worker-spawned descendants.
// node --import ./scripts/tsx.mjs scripts/perf/child-memory-measure.ts --owner <module> --seconds 120 --output <json>
// Pair baseline/candidate on interleaved CPUs, then swap placement. Run --allocations
// and --work-counts separately: their instrumentation is not timing-gate evidence.
// On Node 26, --work-counts --assert-promise-budget checks promises per native read job.
// --sample-delay-ms 1 --seconds 30 accelerates only watcher timers for owner CPU/allocation
// per completed sample. It is not enforcement-latency evidence; run runaway proof separately.
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
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    trees: { type: "string", default: "20" },
    seconds: { type: "string", default: "60" },
    "sample-delay-ms": { type: "string" },
    "start-file": { type: "string" },
    "gc-log": { type: "string" },
    allocations: { type: "boolean", default: false },
    "work-counts": { type: "boolean", default: false },
    "assert-promise-budget": { type: "boolean", default: false },
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
const integer = (name: "trees" | "seconds", min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const trees = integer("trees", 1);
const seconds = integer("seconds", 1);
const sampleDelayMs = values["sample-delay-ms"]
  ? parseStrictIntegerOption({
      raw: values["sample-delay-ms"],
      label: "--sample-delay-ms",
      min: 1,
      fallback: 1,
    })
  : undefined;
assert.ok(!sampleDelayMs || !values.runaway, "Run runaway proof with the real sampling intervals");
const outputPath = path.resolve(values.output);
const profilePath = `${outputPath}.heapprofile`;
const fixture = fileURLToPath(new URL("./child-memory-fixture.cjs", import.meta.url));
const marker = (phase: string) =>
  fs.writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
const { watchChildMemory }: typeof import("../../src/process/child-memory.js") = await import(
  values.owner
    ? pathToFileURL(path.resolve(values.owner)).href
    : "../../src/process/child-memory.js"
);
if (values["gc-log"]) {
  assert.ok(global.gc, "Trace mode requires --expose-gc");
  marker("identify-start");
  global.gc();
  marker("identify-stop");
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
    const child = spawn(process.execPath, [fixture, "2"], {
      detached: true,
      stdio: ["pipe", "pipe", "inherit"],
    });
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
    const startWatch = () =>
      watchChildMemory({
        pid: child.pid,
        limitBytes: 768 * 1024 ** 2,
        onLimit: () => {
          if (bursting && index === trees - 1) {
            process.kill(-child.pid!, "SIGKILL");
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
    stops.push(sampleDelayMs ? watcherContext.run(true, startWatch) : startWatch());
  }
  await delay(5000);
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
  marker("heap-start");
  capturingSamples = true;
  await delay(seconds * 1000);
  capturingSamples = false;
  marker("heap-stop");
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
  assert.equal(failure, undefined);
  assert.ok(!sampleDelayMs || completedSamples > 0, "No completed watcher samples were measured");
  const result = {
    scope:
      "watchChildMemory with real procfs; 20 independent trees by default, two worker-spawned descendants per tree",
    timingGateEligible:
      !sampleDelayMs && !values.allocations && !values["gc-log"] && !values["work-counts"],
    acceleratedSampling: sampleDelayMs
      ? {
          delayMs: sampleDelayMs,
          completedSamples,
          requestedIntervals,
          cpuMsPerSample: (cpu.user + cpu.system) / 1000 / completedSamples,
          mainThreadCpuMsPerSample: (threadCpu.user + threadCpu.system) / 1000 / completedSamples,
          v8AllocationBytesPerSample: allocatedBytes / completedSamples,
        }
      : null,
    trees,
    seconds,
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
