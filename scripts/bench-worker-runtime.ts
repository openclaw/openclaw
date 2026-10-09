import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { createHistogram, performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getTrackedWorkerLifecycleSnapshot } from "../src/infra/worker-cpu.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../src/infra/worker-native-lifecycle.js";
import { createOwnedWorkerTaskPool } from "../src/infra/worker-task-pool.js";
import type { WorkerTaskOptions } from "../src/infra/worker-task-pool.types.js";
import type {
  WorkerRuntimeBenchmarkInput as Input,
  WorkerRuntimeBenchmarkOutput as Output,
} from "./bench-worker-runtime.worker.js";
import {
  emitBenchmarkReport,
  parseBenchmarkInteger,
  parseBenchmarkOptions,
  runBenchmarkEntrypoint,
} from "./lib/benchmark-harness.mts";
import { startGatewayBenchDiagnostics } from "./lib/gateway-bench-diagnostics.js";

type Transport = "ordinary" | "retained";
type Scenario = "roundtrip" | "saturated" | "host-exchange";
type Options = {
  transport: Transport | "both";
  scenario: Scenario | "all";
  workers: number;
  concurrency: number;
  tasks: number;
  warmup: number;
  payloadBytes: number;
  exchanges: number;
  runs: number;
  servicePasses: number;
  transfer: "clone" | "move";
  diagnostics: "on" | "off";
  json: boolean;
  help: boolean;
  output?: string;
};

type Pool = ReturnType<typeof createOwnedWorkerTaskPool<Input, Output>>;
const workerUrl = new URL("./bench-worker-runtime.worker.ts", import.meta.url);
const taskTimeoutMs = 120_000;

function usage() {
  return `OpenClaw worker runtime benchmark

Usage:
  pnpm exec tsx scripts/bench-worker-runtime.ts [options]

Options:
  --transport <name>    ordinary, retained, or both (default: both)
  --scenario <name>     roundtrip, saturated, host-exchange, or all (default: all)
  --workers <n>         Worker limit (default: 2; maximum: 32)
  --concurrency <n>     In-flight producer limit except roundtrip (default: 8; maximum: 128)
  --tasks <n>           Measured warm tasks per sample (default: 500)
  --warmup <n>          Unmeasured tasks after the cold wave (default: 32)
  --payload-bytes <n>   Echoed bytes per task (default: 1024; maximum: 8388608)
  --exchanges <n>       Sequential host replies per host-exchange task (default: 4)
  --runs <n>            Fresh pools per transport/scenario (default: 2)
  --service-passes <n>  Additional retained service passes while workers await host replies
                       (default: 0; separate synthetic empty-poll diagnostic)
  --transfer <name>     clone or move payloads in both directions (default: clone)
  --diagnostics <name>  on or off for stage distributions (default: on)
  --output <path>       Write JSON report
  --json               Print JSON instead of the summary
  --help               Show this text

Cold includes Worker/bootstrap startup after host imports. Warm includes input generation,
output validation, and optional diagnostic subscribers. CPU is process-wide (all threads).
RSS is process-wide; heap/external/arrayBuffers describe only the calling isolate.
`;
}

function choice<T extends string>(raw: string, flag: string, allowed: readonly T[]): T {
  const value = allowed.find((candidate) => candidate === raw);
  if (!value) {
    throw new Error(`${flag} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function parseOptions(): Options {
  const parsed = parseBenchmarkOptions<Options>(
    process.argv.slice(2),
    {
      transport: "both",
      scenario: "all",
      workers: 2,
      concurrency: 8,
      tasks: 500,
      warmup: 32,
      payloadBytes: 1024,
      exchanges: 4,
      runs: 2,
      servicePasses: 0,
      transfer: "clone",
      diagnostics: "on",
      json: false,
      help: false,
    },
    {
      "--transport": (options, value) => {
        options.transport = choice(value, "--transport", ["ordinary", "retained", "both"]);
      },
      "--scenario": (options, value) => {
        options.scenario = choice(value, "--scenario", [
          "roundtrip",
          "saturated",
          "host-exchange",
          "all",
        ]);
      },
      "--workers": (options, value) => {
        options.workers = parseBenchmarkInteger(value, "--workers", 1, 32);
      },
      "--concurrency": (options, value) => {
        options.concurrency = parseBenchmarkInteger(value, "--concurrency", 1, 128);
      },
      "--tasks": (options, value) => {
        options.tasks = parseBenchmarkInteger(value, "--tasks", 1, 1_000_000);
      },
      "--warmup": (options, value) => {
        options.warmup = parseBenchmarkInteger(value, "--warmup", 0, 100_000);
      },
      "--payload-bytes": (options, value) => {
        options.payloadBytes = parseBenchmarkInteger(value, "--payload-bytes", 0, 8 * 1024 * 1024);
      },
      "--exchanges": (options, value) => {
        options.exchanges = parseBenchmarkInteger(value, "--exchanges", 1, 100);
      },
      "--runs": (options, value) => {
        options.runs = parseBenchmarkInteger(value, "--runs", 1, 20);
      },
      "--service-passes": (options, value) => {
        options.servicePasses = parseBenchmarkInteger(value, "--service-passes", 0, 1_000_000);
      },
      "--transfer": (options, value) => {
        options.transfer = choice(value, "--transfer", ["clone", "move"]);
      },
      "--diagnostics": (options, value) => {
        options.diagnostics = choice(value, "--diagnostics", ["on", "off"]);
      },
      "--output": (options, value) => {
        options.output = value;
      },
    },
  );
  if (Math.max(parsed.workers, parsed.concurrency) * parsed.payloadBytes > 256 * 1024 * 1024) {
    throw new Error("workers/concurrency × payload-bytes must fit the 256 MiB admission budget");
  }
  if (parsed.servicePasses > 0 && parsed.transport === "ordinary") {
    throw new Error("--service-passes requires retained transport");
  }
  return parsed;
}

/** Always join cleanup, preserving both failures instead of letting teardown replace the result. */
async function withJoinedCleanup<Value, Cleanup>(
  measure: () => Promise<Value>,
  cleanup: () => Promise<Cleanup>,
) {
  const [measured] = await Promise.allSettled([Promise.resolve().then(measure)]);
  const [cleaned] = await Promise.allSettled([Promise.resolve().then(cleanup)]);
  if (measured.status === "rejected") {
    if (cleaned.status === "rejected") {
      throw new AggregateError(
        [measured.reason, cleaned.reason],
        `${toErrorObject(measured.reason, "Measurement failed").message}; additionally cleanup failed: ${toErrorObject(cleaned.reason, "Cleanup failed").message}`,
        { cause: measured.reason },
      );
    }
    throw measured.reason;
  }
  if (cleaned.status === "rejected") {
    throw cleaned.reason;
  }
  return { value: measured.value, cleanup: cleaned.value };
}

function cpuDelta(start: NodeJS.CpuUsage) {
  const cpu = process.cpuUsage(start);
  return {
    user: cpu.user / 1000,
    system: cpu.system / 1000,
    total: (cpu.user + cpu.system) / 1000,
  };
}

function inputFor(id: number, options: Options, exchanges: number): Input {
  return {
    id,
    payload: new Uint8Array(options.payloadBytes).fill(id % 256),
    exchanges,
    transfer: options.transfer === "move",
  };
}

function transferInput(input: Input) {
  const buffer = input.payload.buffer;
  assert.ok(buffer instanceof ArrayBuffer);
  return [buffer];
}

function verifyOutput(output: Output, id: number, options: Options, exchanges: number) {
  assert.equal(output.id, id);
  assert.equal(output.exchanges, exchanges);
  assert.equal(output.transfer, options.transfer === "move");
  assert.equal(output.payload.byteLength, options.payloadBytes);
  assert.equal(output.checksum, (id % 256) * options.payloadBytes);
  assert.ok(
    output.payload.every((byte) => byte === id % 256),
    "echoed payload changed",
  );
  assert.ok(Number.isSafeInteger(output.threadId) && output.threadId > 0);
}

async function runPhase(
  pool: Pool,
  options: Options,
  count: number,
  concurrency: number,
  exchanges: number,
) {
  // Microsecond resolution and fixed storage; no per-task timing array grows with --tasks.
  const latency = createHistogram({ lowest: 1, highest: 3_600_000_000, figures: 3 });
  const threads = new Set<number>();
  const receipts = { inputs: 0, executions: 0, requests: 0, responses: 0 };
  let submitted = 0;
  let completed = 0;
  let failed = false;
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const producer = async () => {
    while (!failed && submitted < count) {
      const id = ++submitted;
      const taskOptions: WorkerTaskOptions<Input> = {
        inputBytes: options.payloadBytes,
        timeoutMs: taskTimeoutMs,
        transferList: options.transfer === "move" ? transferInput : undefined,
        // Explicit consumption requires the interactive channel's consumeInput receipt.
        onInputConsumed: exchanges > 0 ? () => receipts.inputs++ : undefined,
        onExecutionSettled: () => receipts.executions++,
        onRequest:
          exchanges === 0
            ? undefined
            : async (value) => {
                assert.ok(isRecord(value));
                assert.equal(value.id, id);
                assert.equal(typeof value.exchange, "number");
                receipts.requests++;
                return {
                  input: value,
                  timeoutMs: taskTimeoutMs,
                  onConsumed: () => receipts.responses++,
                };
              },
      };
      const taskStarted = performance.now();
      try {
        const output = await pool.run(() => inputFor(id, options, exchanges), taskOptions);
        latency.record(Math.max(1, Math.round((performance.now() - taskStarted) * 1000)));
        verifyOutput(output, id, options, exchanges);
        threads.add(output.threadId);
        completed++;
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const producers = await Promise.allSettled(
    Array.from({ length: Math.min(count, concurrency) }, producer),
  );
  const errors = producers.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length) {
    throw new AggregateError(
      errors,
      `Worker benchmark tasks failed: ${errors.map(String).join("; ")}`,
      { cause: errors[0] },
    );
  }
  const elapsedMs = performance.now() - started;
  const processCpuMs = cpuDelta(cpuBefore);
  const memoryAfter = process.memoryUsage();
  assert.equal(completed, count);
  assert.deepEqual(receipts, {
    inputs: exchanges > 0 ? count : 0,
    executions: count,
    requests: count * exchanges,
    responses: count * exchanges,
  });
  assert.equal(pool.getSnapshot().pendingTasks, 0, "phase left pending tasks");
  assert.equal(pool.getSnapshot().activeTasks, 0, "phase left active tasks");
  assert.equal(latency.exceeds, 0, "latency exceeded histogram range");
  return {
    tasks: count,
    concurrency,
    exchangesPerTask: exchanges,
    workersUsed: threads.size,
    elapsedMs,
    tasksPerSecond: count / (elapsedMs / 1000),
    processCpuMs,
    latencyMs: {
      count: latency.count,
      min: count ? latency.min / 1000 : 0,
      p50: count ? latency.percentile(50) / 1000 : 0,
      p95: count ? latency.percentile(95) / 1000 : 0,
      p99: count ? latency.percentile(99) / 1000 : 0,
      max: count ? latency.max / 1000 : 0,
    },
    memory: { before: memoryBefore, after: memoryAfter },
    receipts,
  };
}

async function measurePhase(...args: Parameters<typeof runPhase>) {
  const stopDiagnostics = args[1].diagnostics === "on" ? startGatewayBenchDiagnostics() : undefined;
  let diagnostics;
  let result;
  try {
    result = await runPhase(...args);
  } finally {
    diagnostics = stopDiagnostics?.();
  }
  if (diagnostics) {
    assert.equal(diagnostics.droppedEvents, 0, "diagnostic group limit exceeded");
    assert.equal(diagnostics.collectionErrors, 0, "diagnostic collection failed");
  }
  return { ...result, diagnostics: diagnostics ?? null };
}

async function measureEmptyService(pool: Pool, options: Options) {
  const allWaiting = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  let waiting = 0;
  let consumed = 0;
  const tasks = Array.from({ length: options.workers }, (_, index) =>
    pool.startTask(() => inputFor(index + 1, options, 1), {
      inputBytes: options.payloadBytes,
      timeoutMs: taskTimeoutMs,
      transferList: options.transfer === "move" ? transferInput : undefined,
      onRequest: async (value) => {
        if (++waiting === options.workers) {
          allWaiting.resolve();
        }
        await reply.promise;
        return { input: value, timeoutMs: taskTimeoutMs, onConsumed: () => consumed++ };
      },
    }),
  );
  const results = Promise.all(tasks.map((task) => task.result));
  // A startup/task failure must reject the barrier too, rather than hanging the benchmark.
  void results.catch(allWaiting.reject);
  const measured = await withJoinedCleanup(
    async () => {
      await allWaiting.promise;
      const cpuBefore = process.cpuUsage();
      const started = performance.now();
      for (let pass = 0; pass < options.servicePasses; pass++) {
        tasks[0]!.service();
      }
      const elapsedMs = performance.now() - started;
      const processCpuMs = cpuDelta(cpuBefore);
      reply.resolve();
      const outputs = await results;
      outputs.forEach((output, index) => verifyOutput(output, index + 1, options, 1));
      assert.equal(consumed, options.workers);
      return { passes: options.servicePasses, elapsedMs, processCpuMs, waitingWorkers: waiting };
    },
    async () => {
      reply.resolve();
      const releases = await Promise.allSettled(tasks.map((task) => task.release().result));
      const errors = releases.flatMap((release) =>
        release.status === "rejected" ? [release.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Retained benchmark task release failed", {
          cause: errors[0],
        });
      }
    },
  );
  return measured.value;
}

async function runSample(options: Options, transport: Transport, scenario: Scenario, run: number) {
  const source =
    transport === "retained"
      ? captureRetainedNativeWorkerSource({ runtimeGeneration: undefined })
      : undefined;
  const pool = createOwnedWorkerTaskPool<Input, Output>(
    {
      workerUrl,
      maxWorkers: options.workers,
      maxPendingTasks: Math.max(options.workers, options.concurrency),
      maxPendingBytes: 256 * 1024 * 1024,
      idleTimeoutMs: 0,
      sharedCompute: false,
    },
    source ? { retainedTransport: true, nativeSource: source } : undefined,
  );
  const exchanges = scenario === "host-exchange" ? options.exchanges : 0;
  const concurrency = scenario === "roundtrip" ? 1 : options.concurrency;
  const baselineWorkers = getTrackedWorkerLifecycleSnapshot().workerCount;
  const sample = await withJoinedCleanup(
    async () => {
      const cold = await measurePhase(pool, options, options.workers, options.workers, exchanges);
      assert.equal(
        cold.workersUsed,
        options.workers,
        "cold wave did not use every configured worker",
      );
      assert.equal(
        pool.getSnapshot().workersCreated,
        options.workers,
        "cold wave replaced workers",
      );
      await measurePhase(pool, options, options.warmup, concurrency, exchanges);
      const warm = await measurePhase(pool, options, options.tasks, concurrency, exchanges);
      const emptyService =
        source && options.servicePasses > 0 ? await measureEmptyService(pool, options) : undefined;
      assert.equal(
        pool.getSnapshot().workersCreated,
        options.workers,
        "warm workload replaced workers",
      );
      return { run, transport, scenario, cold, warm, emptyService };
    },
    async () => {
      const started = performance.now();
      await withJoinedCleanup(() => pool.close(), closeDefaultRetainedNativeWorkerSource);
      assert.equal(pool.getSnapshot().workers, 0, "cleanup left pool workers");
      assert.equal(pool.getSnapshot().activeTasks, 0, "cleanup left active tasks");
      assert.equal(pool.getSnapshot().pendingTasks, 0, "cleanup left pending tasks");
      assert.equal(source?.hasActiveWorkers ?? false, false, "cleanup left native workers");
      assert.equal(
        getTrackedWorkerLifecycleSnapshot().workerCount,
        baselineWorkers,
        `cleanup left tracked workers: ${JSON.stringify(getTrackedWorkerLifecycleSnapshot())}`,
      );
      return {
        elapsedMs: performance.now() - started,
        ownedWorkersRemaining: 0,
        trackedWorkersBefore: baselineWorkers,
        trackedWorkersAfter: getTrackedWorkerLifecycleSnapshot().workerCount,
        pendingTasks: 0,
      };
    },
  );
  return { ...sample.value, cleanup: sample.cleanup };
}

function sourceIdentity() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const diff = git("diff", "HEAD", "--", "packages/worker-runtime", "src", "scripts");
  return {
    head: git("rev-parse", "HEAD").trim(),
    trackedDiffSha256: createHash("sha256").update(diff).digest("hex"),
    trackedChanges: diff.length > 0,
    benchmarkSha256: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    fixtureSha256: createHash("sha256").update(readFileSync(workerUrl)).digest("hex"),
  };
}

async function main() {
  const options = parseOptions();
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const source = sourceIdentity();
  // Node defers process-level Worker events; include the source loader in the baseline.
  await setImmediate();
  const scenarios: Scenario[] =
    options.scenario === "all" ? ["roundtrip", "saturated", "host-exchange"] : [options.scenario];
  const samples = [];
  for (let run = 1; run <= options.runs; run++) {
    // Alternate order to expose startup/JIT/order bias instead of always favoring one transport.
    const transports: Transport[] =
      options.transport === "both"
        ? run % 2 === 1
          ? ["ordinary", "retained"]
          : ["retained", "ordinary"]
        : [options.transport];
    for (const scenario of scenarios) {
      for (const transport of transports) {
        process.stderr.write(
          `[bench-worker-runtime] run=${run} scenario=${scenario} transport=${transport}\n`,
        );
        const sample = await runSample(options, transport, scenario, run);
        samples.push(sample);
      }
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope:
      "actual OpenClaw pool/host/server; synthetic echo and host replies; not Gateway throughput",
    measurement: {
      cold: "first wave creates all configured Workers; includes source-loader/bootstrap, excludes host imports",
      warm: `after cold wave and warmup; includes generation and validation; diagnostics ${options.diagnostics}`,
      latency:
        "submission to result, includes queue/preparation/transport; excludes output validation; microsecond histogram",
      cpu: "process-wide CPU across main and Worker threads, including diagnostic/fixture work",
      memory:
        "RSS process-wide; heap, external and arrayBuffers main-isolate only; no forced GC; not a leak test",
      emptyService:
        "synthetic synchronous service passes while every retained Worker waits for a held host reply",
      diagnostics:
        "runMs includes startup/transport/hostWait/cleanup; hostWaitMs is a component, not additional CPU time",
    },
    source,
    runtime: {
      node: process.version,
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
      availableParallelism: availableParallelism(),
      logicalCpus: cpus().length,
    },
    options,
    samples,
  };
  emitBenchmarkReport(report, options, (result) =>
    result.samples.flatMap((sample) => [
      `${sample.transport} ${sample.scenario} run=${sample.run}: cold=${sample.cold.elapsedMs.toFixed(1)}ms warm=${sample.warm.elapsedMs.toFixed(1)}ms cpu=${sample.warm.processCpuMs.total.toFixed(1)}ms p50=${sample.warm.latencyMs.p50.toFixed(3)}ms p95=${sample.warm.latencyMs.p95.toFixed(3)}ms p99=${sample.warm.latencyMs.p99.toFixed(3)}ms`,
      ...(sample.emptyService
        ? [
            `  empty-service passes=${sample.emptyService.passes} wall=${sample.emptyService.elapsedMs.toFixed(1)}ms cpu=${sample.emptyService.processCpuMs.total.toFixed(1)}ms`,
          ]
        : []),
    ]),
  );
}

await runBenchmarkEntrypoint("bench-worker-runtime", main);
