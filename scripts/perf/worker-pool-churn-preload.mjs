// Diagnostic-only preload for synthetic Gateway worker churn measurements.
// node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts ... --mode allocation
// --gateway-preload scripts/perf/worker-pool-churn-preload.mjs
// Evidence goes in each isolated state's pool-churn directory.
// Startup ends at first task delivery, before its handler; CPU excludes native thread startup.
// Allocation estimate = heap growth + GC-reclaimed bytes, excluding native/external memory.
// Never use this GCProfiler pass for latency or GC acceptance gates.
import { appendFileSync, mkdirSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { GCProfiler } from "node:v8";
import threads, { isMainThread, MessagePort, parentPort, threadId } from "node:worker_threads";

const output =
  process.env.OPENCLAW_BENCH_POOL_CHURN_DIR ??
  (process.env.OPENCLAW_STATE_DIR
    ? path.join(process.env.OPENCLAW_STATE_DIR, "pool-churn")
    : undefined);
if (output && isMainThread) {
  mkdirSync(output, { recursive: true });
  const key = Symbol.for("openclaw.bench.pool-churn");
  const pools = new WeakMap();
  const live = new Map();
  let sequence = 0;
  const write = (record) =>
    appendFileSync(
      path.join(output, "pools.jsonl"),
      `${JSON.stringify({ atEpochMs: Date.now(), ...record })}\n`,
    );
  globalThis[key] = (worker, pool) => {
    let id = pools.get(pool);
    if (id === undefined) {
      id = ++sequence;
      pools.set(pool, id);
    }
    const identity = {
      poolId: id,
      threadId: worker.threadId,
      script: path.basename(pool.options.workerUrl.pathname),
    };
    live.set(id, new WeakRef(pool));
    write({
      phase: "started",
      ...identity,
      idleTimeoutMs: pool.options.idleTimeoutMs,
      burstIdleTimeoutMs: pool.options.burstIdleTimeoutMs,
      ...pool.getSnapshot(),
    });
    worker.once("exit", () => write({ phase: "exit", ...identity }));
  };
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!/\/[^/]*worker-cpu-[^/]+\.mjs$/.test(url) || !result.source) {
        return result;
      }
      const source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      const declaration = "function attributeWorkerToPool(worker, pool, workerClass) {";
      if (!source.includes(declaration)) {
        return result;
      }
      write({ phase: "hook-installed", module: path.basename(url) });
      return {
        ...result,
        source: source.replace(
          declaration,
          `${declaration}\nglobalThis[Symbol.for("openclaw.bench.pool-churn")]?.(worker, pool);`,
        ),
      };
    },
  });
  setInterval(() => {
    for (const [id, ref] of live) {
      const pool = ref.deref();
      if (pool) {
        write({ phase: "sample", poolId: id, ...pool.getSnapshot() });
      } else {
        live.delete(id);
      }
    }
  }, 10_000).unref();
}
if (output) {
  const NativeWorker = threads.Worker;
  threads.Worker = class extends NativeWorker {
    constructor(filename, options = {}) {
      super(filename, {
        ...options,
        execArgv:
          options.execArgv === undefined || options.execArgv.includes(import.meta.url)
            ? options.execArgv
            : [...options.execArgv, "--import", import.meta.url],
        env:
          options.env === threads.SHARE_ENV
            ? options.env
            : {
                ...(options.env ?? process.env),
                OPENCLAW_BENCH_POOL_CHURN_DIR: output,
                OPENCLAW_BENCH_POOL_SPAWN_AT: String(Date.now()),
              },
      });
    }
  };
  syncBuiltinESMExports();
}

const script = path.basename(process.argv[1] ?? "");
if (
  output &&
  !isMainThread &&
  /^(session-transcript|openclaw-state-read|git-operation|disk-budget|plugin-model-catalog-read)\.worker\.[cm]?[jt]s$/.test(
    script,
  )
) {
  mkdirSync(output, { recursive: true });
  const file = path.join(output, `${process.pid}-${threadId}.jsonl`);
  const started = performance.now();
  const cpu = process.threadCpuUsage();
  const initial = process.memoryUsage();
  const profiler = new GCProfiler();
  let reclaimed = 0;
  let completed = 0;
  let first = true;
  let active = false;
  let idleAt;
  profiler.start();
  const write = (phase) => {
    const used = process.threadCpuUsage(cpu);
    const memory = process.memoryUsage();
    if (phase === "first-task") {
      const profile = profiler.stop();
      for (const gc of profile.statistics) {
        reclaimed +=
          gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize;
      }
    }
    appendFileSync(
      file,
      `${JSON.stringify({
        phase,
        script,
        pid: process.pid,
        threadId,
        atEpochMs: Date.now(),
        elapsedMs: performance.now() - started,
        spawnToNowMs: Date.now() - Number(process.env.OPENCLAW_BENCH_POOL_SPAWN_AT),
        threadCpuMs: (used.user + used.system) / 1000,
        estimatedAllocatedBytes:
          phase === "first-task" ? memory.heapUsed - initial.heapUsed + reclaimed : undefined,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        completed,
        active,
        resultIdleMs: idleAt === undefined ? null : performance.now() - idleAt,
      })}\n`,
    );
  };
  const observed = new WeakSet();
  const observe = (port) => {
    if (observed.has(port)) {
      return;
    }
    observed.add(port);
    const incoming = (message) => {
      if (message?.type === "openclaw.worker-task-port" && message.port instanceof MessagePort) {
        observe(message.port);
      }
      if (typeof message?.taskId === "number" && "input" in message && !("responseId" in message)) {
        if (first) {
          first = false;
          write("first-task");
        }
        active = true;
        idleAt = undefined;
      }
    };
    // Observe only when the actual server attaches; an early listener can drain queued input.
    const listeners = new WeakMap();
    const on = port.on;
    const off = port.off;
    port.on = function (event, listener) {
      if (event !== "message") {
        return on.call(this, event, listener);
      }
      let wrapped = listeners.get(listener);
      if (!wrapped) {
        wrapped = function (message) {
          incoming(message);
          return listener.call(this, message);
        };
        wrapped.listener = listener.listener ?? listener;
        listeners.set(listener, wrapped);
      }
      return on.call(this, event, wrapped);
    };
    port.off = port.removeListener = function (event, listener) {
      return off.call(
        this,
        event,
        event === "message" ? (listeners.get(listener) ?? listener) : listener,
      );
    };
    const post = port.postMessage.bind(port);
    port.postMessage = (...args) => {
      if (typeof args[0]?.taskId === "number" && ["ok", "failed"].includes(args[0].status)) {
        active = false;
        completed++;
        idleAt = performance.now();
        if (completed === 1) {
          write("first-result");
        }
      }
      return post(...args);
    };
  };
  if (parentPort) {
    observe(parentPort);
  }
  setInterval(() => write("sample"), 10_000).unref();
}
