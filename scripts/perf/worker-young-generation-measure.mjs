// Compare real built file-reader workers with default vs bounded young generations.
// node scripts/perf/worker-young-generation-measure.mjs --output .local/worker-young.json
// Optional: --samples 3000 --idle-ms 30000 --young-mb 16 --worker identity-file
// Requires built dist and workspace packages. Runs serial AB/BA pairs through the
// production task-port protocol, with 100 warmups and natural busy/idle snapshots.
// No benchmark-triggered GC or inspector; production idle GC remains enabled.
// RSS includes the parent and allocator retention;
// this owner experiment does not replace whole-Gateway load acceptance.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import {
  isMainThread,
  MessageChannel,
  resourceLimits,
  Worker,
  workerData,
} from "node:worker_threads";

function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (value) => sorted[Math.ceil(sorted.length * value) - 1] ?? null;
  return {
    count: sorted.length,
    total: sorted.reduce((sum, value) => sum + value, 0),
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
}

function memory() {
  return { ...process.memoryUsage(), heap: getHeapStatistics(), spaces: getHeapSpaceStatistics() };
}

if (!isMainThread) {
  const gc = [];
  const record = (entries) => {
    gc.push(
      ...entries.map((entry) => ({
        start: entry.startTime,
        ms: entry.duration,
        kind: entry.detail.kind,
      })),
    );
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const importCpu = process.threadCpuUsage();
  const importAllocation = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(importAllocation), "Requires Node with V8 total_allocated_bytes");
  const importStarted = performance.now();
  await import(workerData.entry);
  const startupCpu = process.threadCpuUsage(importCpu);
  const startup = {
    elapsedMs: performance.now() - importStarted,
    cpuMs: (startupCpu.user + startupCpu.system) / 1000,
    allocatedBytes: getHeapStatistics().total_allocated_bytes - importAllocation,
    memory: memory(),
    resourceLimits,
  };
  let cpu;
  let allocation;
  let began;
  workerData.diagnostics.on("message", ({ id, operation }) => {
    record(observer.takeRecords());
    let value;
    if (operation === "startup") {
      value = startup;
    } else if (operation === "begin") {
      gc.length = 0;
      began = performance.now();
      cpu = process.threadCpuUsage();
      allocation = getHeapStatistics().total_allocated_bytes;
      value = { started: true };
    } else if (operation === "end") {
      const elapsed = process.threadCpuUsage(cpu);
      const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
      const samples = gc.filter((entry) => entry.start >= began);
      value = {
        cpuMs: (elapsed.user + elapsed.system) / 1000,
        allocatedBytes,
        gc: {
          all: distribution(samples.map((entry) => entry.ms)),
          minor: distribution(
            samples
              .filter((entry) => entry.kind === constants.NODE_PERFORMANCE_GC_MINOR)
              .map((entry) => entry.ms),
          ),
          major: distribution(
            samples
              .filter((entry) => entry.kind === constants.NODE_PERFORMANCE_GC_MAJOR)
              .map((entry) => entry.ms),
          ),
        },
        memory: memory(),
      };
      gc.length = 0;
    } else {
      value = { memory: memory(), gc: distribution(gc.map((entry) => entry.ms)) };
    }
    workerData.diagnostics.postMessage({ id, value }, []);
  });
  workerData.diagnostics.postMessage({ ready: true }, []);
} else {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      samples: { type: "string", default: "3000" },
      "idle-ms": { type: "string", default: "30000" },
      "young-mb": { type: "string", default: "16" },
      worker: { type: "string" },
    },
  });
  assert(values.output, "--output is required");
  const samples = Number(values.samples);
  const idleMs = Number(values["idle-ms"]);
  const youngMb = Number(values["young-mb"]);
  assert(Number.isSafeInteger(samples) && samples > 0, "--samples must be a positive integer");
  assert(Number.isSafeInteger(idleMs) && idleMs >= 0, "--idle-ms must be a nonnegative integer");
  assert(Number.isSafeInteger(youngMb) && youngMb > 0, "--young-mb must be a positive integer");
  const entries = {
    "identity-file": "../../dist/agents/identity-file.worker.js",
    "identity-avatar-file": "../../dist/agents/identity-avatar-file.worker.js",
    "control-ui-file": "../../dist/gateway/control-ui-file.worker.js",
  };
  assert(!values.worker || Object.hasOwn(entries, values.worker), "Unknown --worker");
  const output = path.resolve(values.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const state = await fs.mkdtemp(path.join(path.dirname(output), "worker-young-fixture-"));
  await fs.writeFile(path.join(state, "avatar.png"), Buffer.alloc(65536, 42));
  await fs.writeFile(
    path.join(state, "IDENTITY.md"),
    `- Name: Synthetic\n- Theme: ${"x".repeat(65536 - 28)}\n`,
  );
  const report = {
    node: process.version,
    samples,
    warmup: 100,
    idleMs,
    youngMb,
    startedAt: new Date().toISOString(),
    limitations: [
      "Built worker-boundary workload, not whole Gateway",
      "Process RSS includes parent and retained allocator pages",
      "No benchmark-triggered GC or inspector; production idle GC remains enabled",
    ],
    arms: [],
  };
  try {
    for (const [name, entry] of Object.entries(entries)) {
      if (values.worker && name !== values.worker) {
        continue;
      }
      for (const [index, young] of [undefined, youngMb, youngMb, undefined].entries()) {
        const diagnostics = new MessageChannel();
        const tasks = new MessageChannel();
        const ready = Promise.withResolvers();
        const taskReady = Promise.withResolvers();
        void ready.promise.catch(() => {});
        void taskReady.promise.catch(() => {});
        const rssBeforeWorker = process.memoryUsage().rss;
        const worker = new Worker(new URL(import.meta.url), {
          execArgv: ["--import", new URL("./team-shape-stress-loader.mjs", import.meta.url).href],
          resourceLimits: {
            maxOldGenerationSizeMb: 512,
            ...(young ? { maxYoungGenerationSizeMb: young } : {}),
          },
          workerData: {
            entry: new URL(entry, import.meta.url).href,
            diagnostics: diagnostics.port2,
          },
          transferList: [diagnostics.port2],
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: path.join(state, "state"),
            OPENCLAW_HOME: path.join(state, "home"),
            TMPDIR: state,
          },
        });
        const pending = new Map();
        let sequence = 0;
        let task;
        let fatal;
        let memoryPort;
        const nativeSections = new SharedArrayBuffer(4);
        const fail = (error) => {
          fatal = error;
          ready.reject(error);
          taskReady.reject(error);
          task?.reject(error);
          for (const promise of pending.values()) {
            promise.reject(error);
          }
        };
        worker.on("error", fail);
        worker.on("exit", (code) => fail(new Error(`Worker exited: ${code}`)));
        diagnostics.port1.on("message", (message) => {
          if (message.ready) {
            ready.resolve();
          } else {
            pending.get(message.id)?.resolve(message.value);
            pending.delete(message.id);
          }
        });
        tasks.port1.on("message", (message) => {
          if (message.status === "ready") {
            taskReady.resolve();
          } else if (message.status === "memory") {
            memoryPort = message.port;
            memoryPort.on("message", () => {});
            memoryPort.unref();
          } else if (message.status === "ok") {
            task?.resolve(message.value);
          } else if (message.status === "failed") {
            task?.reject(new Error(JSON.stringify(message.error)));
          } else if (message.status === "request") {
            task?.reject(new Error("Unexpected host request"));
          }
        });
        const diagnose = (operation) => {
          if (fatal) {
            throw fatal;
          }
          const promise = Promise.withResolvers();
          pending.set(++sequence, promise);
          diagnostics.port1.postMessage({ id: sequence, operation });
          return promise.promise;
        };
        const input =
          name === "identity-file"
            ? { identityPath: path.join(state, "IDENTITY.md") }
            : name === "identity-avatar-file"
              ? { workspaceDir: state, source: "avatar.png", readBody: true }
              : {
                  rootPath: state,
                  rootRealPath: state,
                  filePath: path.join(state, "avatar.png"),
                  rejectHardlinks: true,
                  readBody: true,
                };
        const run = async () => {
          if (fatal) {
            throw fatal;
          }
          task = Promise.withResolvers();
          tasks.port1.postMessage({
            taskId: ++sequence,
            input,
            interactive: false,
            nativeSections,
            taskContext: { deletedAgentDatabaseFences: [] },
            sampleMemory: true,
          });
          const timeout = setTimeout(() => task?.reject(new Error("Task timed out")), 30000);
          try {
            const result = await task.promise;
            if (name === "identity-file") {
              assert.equal(result.kind, "loaded");
              assert.equal(result.size, 65536);
              assert.equal(result.identity.name, "Synthetic");
            } else {
              if (name === "identity-avatar-file") {
                assert(result.ok);
              }
              const body = name === "identity-avatar-file" ? result.file.body : result.body;
              assert.equal(body.byteLength, 65536);
              assert.equal(body[0], 42);
              assert.equal(body[65535], 42);
            }
          } finally {
            clearTimeout(timeout);
            task = undefined;
          }
        };
        try {
          const startupTimeout = setTimeout(
            () => fail(new Error("Worker startup timed out")),
            60000,
          );
          try {
            await ready.promise;
            worker.postMessage({ type: "openclaw.worker-task-port", port: tasks.port2 }, [
              tasks.port2,
            ]);
            await taskReady.promise;
          } finally {
            clearTimeout(startupTimeout);
          }
          const startup = await diagnose("startup");
          for (let warmup = 0; warmup < 100; warmup++) {
            await run();
          }
          const warmed = await diagnose("sample");
          await diagnose("begin");
          const loadStart = os.loadavg();
          const started = performance.now();
          const latency = [];
          for (let iteration = 0; iteration < samples; iteration++) {
            const before = performance.now();
            await run();
            latency.push(performance.now() - before);
          }
          const elapsedMs = performance.now() - started;
          const busy = await diagnose("end");
          await delay(idleMs);
          const idle = await diagnose("sample");
          const arm = {
            name,
            index,
            arm: young ? "candidate" : "base",
            young: young ?? null,
            rssBeforeWorker,
            startup,
            warmed,
            busy,
            idle,
            elapsedMs,
            latencyMs: distribution(latency),
            loadStart,
            loadEnd: os.loadavg(),
          };
          report.arms.push(arm);
          await fs.writeFile(output, JSON.stringify(report, null, 2));
          console.log(
            JSON.stringify({
              name,
              index,
              arm: arm.arm,
              cpuMs: busy.cpuMs,
              allocatedBytes: busy.allocatedBytes,
              p95Ms: arm.latencyMs.p95,
              heapTotal: idle.memory.heapTotal,
            }),
          );
        } finally {
          await worker.terminate();
          memoryPort?.close();
          diagnostics.port1.close();
          tasks.port1.close();
        }
      }
    }
  } finally {
    await fs.rm(state, { recursive: true, force: true });
  }
}
