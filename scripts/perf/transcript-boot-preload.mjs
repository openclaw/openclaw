// Synthetic boot census (untraced; no task payloads or database/session paths):
// OPENCLAW_BENCH_TRANSCRIPT_BOOT_DIR="$PWD/.local/boot-census" \
//   node --import ./scripts/perf/transcript-boot-preload.mjs dist/index.js gateway ...
// Use a fresh output directory per arm. Each process/thread writes its own JSONL.
// worker-created/worker-exit records belong to the spawning thread, including the
// retained-worker broker. Task timings include receipt-to-reply time, not just SQL.
// Sampling and synchronous census writes add observation overhead; use identically
// instrumented arms. No forced GC, tracing, heap snapshots, or source transforms.
import { appendFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import workerThreads, {
  isMainThread,
  MessagePort,
  parentPort,
  threadId,
} from "node:worker_threads";

const output = process.env.OPENCLAW_BENCH_TRANSCRIPT_BOOT_DIR;
if (!output || !path.isAbsolute(output)) {
  throw new Error("Transcript boot census requires an absolute synthetic output directory");
}
mkdirSync(output, { recursive: true });
const file = path.join(output, `boot-${process.pid}-${threadId}.jsonl`);
const workerEntry = path.basename(process.argv[1] ?? "unknown");
const write = (record) =>
  appendFileSync(
    file,
    `${JSON.stringify({ atEpochMs: Date.now(), pid: process.pid, threadId, workerEntry, ...record })}\n`,
  );
const sample = () => ({
  memory: process.memoryUsage(),
  threadCpuMicros: process.threadCpuUsage?.() ?? null,
  totalAllocatedBytes: getHeapStatistics().total_allocated_bytes ?? null,
  maxRssKiB: process.resourceUsage().maxRSS,
  hostLoad: os.loadavg(),
});
write({ event: "thread-start", isMainThread, ...sample() });

// Pools may override execArgv/env, and retained workers are born in a broker.
// Propagate only this observer; preserve native inheritance when argv is omitted.
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const startedAt = performance.now();
    const startedAtEpochMs = Date.now();
    super(filename, {
      ...options,
      execArgv:
        options.execArgv === undefined || options.execArgv.includes(import.meta.url)
          ? options.execArgv
          : [...options.execArgv, "--import", import.meta.url],
      env:
        options.env === workerThreads.SHARE_ENV
          ? options.env
          : { ...(options.env ?? process.env), OPENCLAW_BENCH_TRANSCRIPT_BOOT_DIR: output },
    });
    const childThreadId = this.threadId;
    const childEntry = options.eval ? "eval" : path.basename(String(filename));
    write({
      event: "worker-created",
      childThreadId,
      childEntry,
      startedAtEpochMs,
      constructorMs: performance.now() - startedAt,
    });
    this.once("exit", (exitCode) => {
      write({ event: "worker-exit", childThreadId, childEntry, exitCode });
    });
  }
};
syncBuiltinESMExports();

if (isMainThread) {
  setInterval(() => write({ event: "sample", ...sample() }), 1_000).unref();
}

if (!isMainThread && /session-transcript\.worker\.[cm]?[jt]s$/.test(workerEntry)) {
  const counts = new Map();
  const observed = new WeakSet();
  let firstTask = true;
  const observePort = (port) => {
    if (observed.has(port)) {
      return;
    }
    observed.add(port);
    const active = new Map();
    const delivered = new WeakSet();
    const observeMessage = (message) => {
      if (!message || typeof message !== "object" || delivered.has(message)) {
        return;
      }
      delivered.add(message);
      if (message.type === "openclaw.worker-task-port" && message.port instanceof MessagePort) {
        observePort(message.port);
      }
      if (
        typeof message.taskId !== "number" ||
        "responseId" in message ||
        !message.input ||
        typeof message.input !== "object"
      ) {
        return;
      }
      // Record only the bounded internal operation discriminator, never input fields.
      const taskKind =
        typeof message.input.kind === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(message.input.kind)
          ? message.input.kind
          : "other";
      const startedAt = performance.now();
      if (firstTask) {
        firstTask = false;
        write({ event: "first-task", taskKind, ...sample() });
      }
      active.set(message.taskId, { taskKind, startedAt });
      counts.set(taskKind, (counts.get(taskKind) ?? 0) + 1);
      write({ event: "task-start", taskId: message.taskId, taskKind });
    };
    // Node's on/once/off APIs delegate here. Wrap actual listener delivery without
    // starting a port early: its startup handoff may precede top-level await completion.
    const listeners = new WeakMap();
    const add = port.addEventListener;
    const remove = port.removeEventListener;
    port.addEventListener = function (type, listener, options) {
      let wrapped = listener;
      if (type === "message" && typeof listener === "function") {
        wrapped = listeners.get(listener);
        if (!wrapped) {
          wrapped = function (message, ...args) {
            observeMessage(message instanceof MessageEvent ? message.data : message);
            return Reflect.apply(listener, this, [message, ...args]);
          };
          listeners.set(listener, wrapped);
        }
      }
      return Reflect.apply(add, this, [type, wrapped, options]);
    };
    port.removeEventListener = function (type, listener, options) {
      return Reflect.apply(remove, this, [
        type,
        type === "message" ? (listeners.get(listener) ?? listener) : listener,
        options,
      ]);
    };
    const post = port.postMessage;
    port.postMessage = function (message, ...args) {
      const task = message && typeof message === "object" ? active.get(message.taskId) : undefined;
      if (task && (message.status === "ok" || message.status === "failed")) {
        write({
          event: "task-end",
          taskId: message.taskId,
          taskKind: task.taskKind,
          status: message.status,
          elapsedMs: performance.now() - task.startedAt,
        });
        active.delete(message.taskId);
      }
      return Reflect.apply(post, this, [message, ...args]);
    };
  };
  if (parentPort) {
    observePort(parentPort);
  }
  setInterval(() => {
    write({ event: "sample", taskCounts: Object.fromEntries(counts), ...sample() });
  }, 1_000).unref();
}

process.once("exit", (exitCode) => {
  write({ event: "thread-exit", exitCode, ...sample() });
});
