// Synthetic benchmarks only. Controllers serialize snapshots and keep them outside timed windows.
// OPENCLAW_BENCH_TRACE_GC=1 is a separate promotion pass; use untraced runs for timing gates.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GCProfiler, getHeapStatistics, setFlagsFromString, writeHeapSnapshot } from "node:v8";
import workerThreads, { isMainThread, threadId } from "node:worker_threads";

const output = process.env.OPENCLAW_BENCH_RETAINED_WORKER_DIR;
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
const traceGc = process.env.OPENCLAW_BENCH_TRACE_GC === "1";
const sampleAllocation = process.env.OPENCLAW_BENCH_SAMPLE_ALLOCATION === "1";
if ((!output && !baseline) || (output && !path.isAbsolute(output))) {
  throw new Error("Worker heap preload requires an absolute synthetic benchmark output directory");
}
if (baseline && !path.isAbsolute(baseline)) {
  throw new Error("Worker heap baseline directory must be absolute");
}
const baselineModules = new Set<string>();
if (baseline) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) {
        const relative = path.relative(root, fileURLToPath(url));
        const replacement = path.join(baseline, relative);
        if (!relative.startsWith("..") && relative.endsWith(".ts") && existsSync(replacement)) {
          baselineModules.add(relative);
          // Let the installed TS loader transform replacement bytes, retaining the requested URL.
          const loaded = nextLoad(pathToFileURL(replacement).href, context);
          return { format: loaded.format, source: loaded.source, shortCircuit: true };
        }
      }
      return nextLoad(url, context);
    },
  });
}

// Native lifecycle workers also create workers; carry the preload through every level.
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(
    filename: ConstructorParameters<typeof NativeWorker>[0],
    options: ConstructorParameters<typeof NativeWorker>[1] = {},
  ) {
    super(filename, {
      ...options,
      execArgv:
        options.execArgv === undefined || options.execArgv.includes(import.meta.url)
          ? options.execArgv
          : [...options.execArgv, "--import", import.meta.url],
      env:
        options.env === workerThreads.SHARE_ENV
          ? options.env
          : {
              ...(options.env ?? process.env),
              ...(output ? { OPENCLAW_BENCH_RETAINED_WORKER_DIR: output } : {}),
              ...(output && traceGc ? { OPENCLAW_BENCH_TRACE_GC: "1" } : {}),
              ...(output && sampleAllocation ? { OPENCLAW_BENCH_SAMPLE_ALLOCATION: "1" } : {}),
              ...(baseline ? { OPENCLAW_BENCH_BASELINE_DIR: baseline } : {}),
            },
    });
  }
};
syncBuiltinESMExports();

type Command = {
  id: string;
  operation: "start" | "stop" | "sample" | "collect" | "snapshot";
  atEpochMs?: number;
};

function readCommand(file: string): Command {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id) ||
    !("operation" in value) ||
    (value.operation !== "start" &&
      value.operation !== "stop" &&
      value.operation !== "sample" &&
      value.operation !== "collect" &&
      value.operation !== "snapshot")
  ) {
    throw new Error("Invalid worker heap command");
  }
  const atEpochMs = "atEpochMs" in value ? value.atEpochMs : undefined;
  if (
    atEpochMs !== undefined &&
    (typeof atEpochMs !== "number" || !Number.isSafeInteger(atEpochMs))
  ) {
    throw new Error("Invalid worker heap command deadline");
  }
  return {
    id: value.id,
    operation: value.operation,
    ...(atEpochMs !== undefined ? { atEpochMs } : {}),
  };
}

const script = path.basename(process.argv[1] ?? "");
if (
  output &&
  !isMainThread &&
  /^(sqlite-store|prepared-model-catalog|session-accessor\.sqlite-archive|openclaw-state-read)\.worker(?:\.baseline)?\.[cm]?[jt]s$/.test(
    script,
  )
) {
  mkdirSync(output, { recursive: true });
  const prefix = path.join(output, `worker-${process.pid}-${threadId}`);
  const commandPath = `${prefix}.command.json`;
  const identity = {
    pid: process.pid,
    threadId,
    script,
    node: process.version,
    traceGc,
    sampleAllocation,
  };
  const traceMarker = (marker: string, commandId: string) => {
    writeSync(1, `${marker} pid=${process.pid} threadId=${threadId} command=${commandId}\n`);
  };
  const memory = () => ({
    ...process.memoryUsage(),
    heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
  });
  const publish = (suffix: string, value: object) => {
    const file = `${prefix}.${suffix}.json`;
    writeFileSync(
      `${file}.tmp`,
      JSON.stringify({
        ...identity,
        commandId: suffix,
        atEpochMs: Date.now(),
        baselineModules: [...baselineModules],
        ...value,
      }),
    );
    renameSync(`${file}.tmp`, file);
  };
  const profiler = new GCProfiler();
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let inspector: Session | undefined;
  let measured:
    | {
        startedAtEpochMs: number;
        startedAt: number;
        cpu: NodeJS.CpuUsage;
        initialMemory: ReturnType<typeof memory>;
        gc: Map<string, number[]>;
        count: number;
        complete: boolean;
        peakHeapUsedBytes: number;
        heapSamples: number;
      }
    | undefined;
  const drainGc = (restart: boolean) => {
    if (!measured) {
      return;
    }
    const profile = profiler.stop();
    if (restart) {
      profiler.start();
    }
    for (const entry of profile?.statistics ?? []) {
      measured.peakHeapUsedBytes = Math.max(
        measured.peakHeapUsedBytes,
        entry.beforeGC.heapStatistics.usedHeapSize,
      );
      measured.count++;
      if (measured.count > 100_000) {
        measured.complete = false;
        continue;
      }
      const samples = measured.gc.get(entry.gcType) ?? [];
      samples.push(entry.cost / 1000);
      measured.gc.set(entry.gcType, samples);
    }
  };
  const distribution = (samples: number[]) => {
    samples.sort((a, b) => a - b);
    const percentile = (fraction: number) =>
      samples.length ? samples[Math.ceil(samples.length * fraction) - 1] : null;
    return {
      samples: samples.length,
      totalMs: samples.reduce((sum, value) => sum + value, 0),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: samples.at(-1) ?? null,
    };
  };
  const collect = async () => {
    if (!inspector) {
      inspector = new Session();
      inspector.connect();
    }
    // Retain the connection until worker exit; disconnecting at GC completion can deadlock V8.
    await inspector.post("HeapProfiler.collectGarbage");
  };
  const execute = async (command: Command) => {
    if (command.atEpochMs !== undefined) {
      if (command.atEpochMs <= Date.now()) {
        throw new Error("Worker heap command missed its scheduled deadline");
      }
      const waitMs = command.atEpochMs - Date.now();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
      });
    }
    if (command.operation === "start") {
      if (measured) {
        throw new Error("Worker heap measurement is already active");
      }
      if (sampleAllocation) {
        if (!inspector) {
          inspector = new Session();
          inspector.connect();
        }
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      if (traceGc) {
        // Identify the isolate before starting counters; forced collections are not workload GC.
        traceMarker("WORKER_GC_IDENTIFY_BEGIN", command.id);
        setFlagsFromString("--trace-gc-nvp");
        try {
          await collect();
        } finally {
          setFlagsFromString("--no-trace-gc-nvp");
          traceMarker("WORKER_GC_IDENTIFY_END", command.id);
        }
        traceMarker("WORKER_GC_BEGIN", command.id);
        setFlagsFromString("--trace-gc-nvp");
      }
      measured = {
        startedAtEpochMs: Date.now(),
        startedAt: performance.now(),
        cpu: process.threadCpuUsage(),
        initialMemory: memory(),
        gc: new Map(),
        count: 0,
        complete: true,
        peakHeapUsedBytes: process.memoryUsage().heapUsed,
        heapSamples: 0,
      };
      loop.reset();
      loop.enable();
      profiler.start();
      publish(command.id, { ok: true, operation: command.operation, ...measured, gc: undefined });
    } else if (command.operation === "stop") {
      if (!measured) {
        throw new Error("Worker heap measurement is not active");
      }
      const endedAtEpochMs = Date.now();
      const elapsedMs = performance.now() - measured.startedAt;
      const cpu = process.threadCpuUsage(measured.cpu);
      const allocation = sampleAllocation
        ? (await inspector!.post("HeapProfiler.stopSampling")).profile
        : undefined;
      if (traceGc) {
        setFlagsFromString("--no-trace-gc-nvp");
        traceMarker("WORKER_GC_END", command.id);
      }
      loop.disable();
      drainGc(false);
      const result = measured;
      measured = undefined;
      publish(command.id, {
        ok: true,
        operation: command.operation,
        complete: result.complete,
        peakHeapUsedBytes: result.peakHeapUsedBytes,
        heapSamples: result.heapSamples,
        startedAtEpochMs: result.startedAtEpochMs,
        endedAtEpochMs,
        elapsedMs,
        cpu,
        ...(allocation
          ? {
              allocation: {
                sampledBytes: allocation.samples.reduce((sum, sample) => sum + sample.size, 0),
                samples: allocation.samples.length,
                samplingInterval: 32768,
                includesCollectedObjects: true,
              },
            }
          : {}),
        initialMemory: result.initialMemory,
        finalMemory: memory(),
        gc: Object.fromEntries(
          [...result.gc].map(([kind, samples]) => [kind, distribution(samples)]),
        ),
        allGc: distribution([...result.gc.values()].flat()),
        eventLoop: {
          samples: loop.count,
          p95Ms: loop.count ? loop.percentile(95) / 1e6 : null,
          p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
          maxMs: loop.count ? loop.max / 1e6 : null,
        },
        promotion:
          "Use isolate-matched --trace-gc-nvp output; GCProfiler does not report promotion",
      });
    } else {
      if (measured) {
        throw new Error("Worker heap samples and snapshots must run outside timed measurement");
      }
      if (command.operation !== "sample") {
        await collect();
      }
      const retained = memory();
      const snapshotPath =
        command.operation === "snapshot"
          ? writeHeapSnapshot(`${prefix}.${command.id}.heapsnapshot`)
          : undefined;
      publish(command.id, {
        ok: true,
        operation: command.operation,
        memory: retained,
        snapshotPath,
      });
    }
  };
  let polling = false;
  // GC boundaries capture synchronous allocation bursts that timer samples can miss.
  setInterval(() => {
    if (measured) {
      measured.peakHeapUsedBytes = Math.max(
        measured.peakHeapUsedBytes,
        process.memoryUsage().heapUsed,
      );
      measured.heapSamples++;
    }
  }, 5).unref();
  setInterval(() => {
    drainGc(true);
    if (polling || !existsSync(commandPath)) {
      return;
    }
    polling = true;
    let command: Command | undefined;
    void (async () => {
      try {
        command = readCommand(commandPath);
        unlinkSync(commandPath);
        await execute(command);
      } catch (error) {
        publish(command?.id ?? "protocol-error", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        polling = false;
      }
    })();
  }, 100).unref();
  // Atomically rename a command JSON into commandPath; await its id-named reply before the next.
  publish("ready", { commandPath });
}
