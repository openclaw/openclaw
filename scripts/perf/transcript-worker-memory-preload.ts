// Benchmark-only observation: never loaded by the normal Gateway launcher.
import { appendFileSync, existsSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { GCProfiler, getHeapStatistics, writeHeapSnapshot } from "node:v8";
import workerThreads, {
  isMainThread,
  MessagePort,
  parentPort,
  threadId,
  type Transferable,
} from "node:worker_threads";

const output = process.env.OPENCLAW_BENCH_WORKER_MEMORY_DIR;
const baselineOwners = process.env.OPENCLAW_BENCH_TRANSCRIPT_BASELINE_OWNERS === "1";
if (!output && !baselineOwners) {
  throw new Error("Transcript memory preload requires its synthetic benchmark output directory");
}
if (output && isMainThread) {
  // Sample the receiving isolate too: worker streaming can still retain the
  // complete selected transcript on the host while summarization is pending.
  const file = path.join(output, `main-${process.pid}.jsonl`);
  setInterval(() => {
    appendFileSync(
      file,
      `${JSON.stringify({ atEpochMs: Date.now(), pid: process.pid, memory: process.memoryUsage(), cpu: process.cpuUsage() })}\n`,
    );
  }, 100).unref();
}
if (baselineOwners) {
  const owners = [
    "session-transcript.worker",
    "session-accessor.sqlite-history-query",
    "session-memory-entry.worker",
    "session-accessor.sqlite-active-context",
    "session-actor-replica",
    "session-actor-receipt",
  ];
  const loadedOwners = new Set<string>();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const owner = owners.find(
        (name) => specifier.endsWith(`/${name}.js`) || specifier.endsWith(`/${name}.ts`),
      );
      if (owner) {
        if (!loadedOwners.has(owner)) {
          loadedOwners.add(owner);
          process.stderr.write(`BASELINE_OWNER ${threadId} ${owner}\n`);
        }
        return {
          url: new URL(`../../src/config/sessions/${owner}.baseline.ts`, import.meta.url).href,
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
}

// Retained workers launch through another worker. Carry this private preload
// through that owner too; do not modify production worker factories or limits.
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(
    filename: ConstructorParameters<typeof NativeWorker>[0],
    options: ConstructorParameters<typeof NativeWorker>[1] = {},
  ) {
    super(filename, {
      ...options,
      // Native inheritance includes this preload and permits V8 flags rejected in explicit argv.
      execArgv:
        options.execArgv === undefined
          ? undefined
          : [...options.execArgv, "--import", import.meta.url],
      env:
        options.env === workerThreads.SHARE_ENV
          ? options.env
          : {
              ...(options.env ?? process.env),
              ...(output ? { OPENCLAW_BENCH_WORKER_MEMORY_DIR: output } : {}),
              ...(output ? { OPENCLAW_BENCH_WORKER_STARTED_AT: String(Date.now()) } : {}),
              ...(process.env.OPENCLAW_BENCH_WORKER_SNAPSHOTS === "1"
                ? { OPENCLAW_BENCH_WORKER_SNAPSHOTS: "1" }
                : {}),
              ...(baselineOwners ? { OPENCLAW_BENCH_TRANSCRIPT_BASELINE_OWNERS: "1" } : {}),
              ...(process.env.OPENCLAW_BENCH_WORKER_PROFILE === "1"
                ? { OPENCLAW_BENCH_WORKER_PROFILE: "1" }
                : {}),
            },
    });
  }
};
syncBuiltinESMExports();

if (
  output &&
  !isMainThread &&
  /session-transcript\.worker(?:\.baseline)?\.[cm]?[jt]s$/.test(process.argv[1] ?? "")
) {
  const file = path.join(output, `transcript-worker-${threadId}.jsonl`);
  let lastObservedOldGenerationAfterGcBytes: number | undefined;
  const sample = () => ({
    ...process.memoryUsage(),
    heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
    lastObservedOldGenerationAfterGcBytes,
  });
  const write = (value: object) =>
    appendFileSync(
      file,
      `${JSON.stringify({ atEpochMs: Date.now(), threadId, workerEntry: path.basename(process.argv[1] ?? ""), ...value })}\n`,
    );
  const kinds = new Set([
    "prewarm",
    "transcript-hydration",
    "compaction-source",
    "transcript-maintenance",
    "history-page",
    "session-entry-list",
    "session-store-projection",
    "session-store-summary",
    "session-store-target",
    "session-target-inventory",
    "combined-store-topology",
    "session-preview",
    "model-context",
    "context-messages",
    "transcript-visible-delta",
    "transcript-raw-delta",
    "transcript-watermark",
    "transcript-anchors",
    "transcript-stats",
    "session-entry",
    "session-entries",
    "usage-cost",
  ]);
  let lastKind = "";
  let observedFirstTask = false;
  const diagnosticStarted = Date.now();
  if (process.env.OPENCLAW_BENCH_WORKER_SNAPSHOTS === "1") {
    // Heap snapshots force GC and block the isolate; never use this pass for latency gates.
    setInterval(() => {
      if (Date.now() - diagnosticStarted < 90_000 || active || !lastKind) {
        return;
      }
      const category =
        lastKind === "usage-cost"
          ? "usage"
          : lastKind === "history-page"
            ? "history"
            : lastKind === "model-context" || lastKind === "transcript-hydration"
              ? "context"
              : "other";
      const receipt = path.join(output, `snapshot-${category}.json`);
      if (existsSync(receipt)) {
        return;
      }
      // Serialize captures across isolates so synthetic proof does not burst disk writes.
      const lock = path.join(output, ".snapshot-lock");
      try {
        mkdirSync(lock);
      } catch {
        return;
      }
      try {
        if (existsSync(receipt)) {
          return;
        }
        const before = sample();
        const snapshot = writeHeapSnapshot(
          path.join(output, `snapshot-${category}-${threadId}.heapsnapshot`),
        );
        writeFileSync(
          receipt,
          JSON.stringify({ threadId, lastKind, before, after: sample(), snapshot }),
        );
      } finally {
        rmdirSync(lock);
      }
    }, 5_000).unref();
  }
  let active:
    | {
        taskId: number;
        kind: string;
        phase?: string;
        startedAt: number;
        before: ReturnType<typeof sample>;
        observedPeakHeapUsed: number;
        parsedBytes: number;
        parseCount: number;
        parseStacks: Record<string, number>;
        majorGcCount: number;
        postMajorGcOldGenerationBytes?: number;
      }
    | undefined;
  let cpuProfiler: Session | undefined;
  const profiler = new GCProfiler();
  profiler.start();
  const drainGc = () => {
    const profile = profiler.stop();
    profiler.start();
    for (const gc of profile?.statistics ?? []) {
      if (gc.gcType !== "MarkSweepCompact") {
        continue;
      }
      lastObservedOldGenerationAfterGcBytes = gc.afterGC.heapSpaceStatistics
        .filter(
          (space) => space.spaceName === "old_space" || space.spaceName === "large_object_space",
        )
        .reduce((total, space) => total + space.spaceUsedSize, 0);
      if (active) {
        active.majorGcCount++;
        active.postMajorGcOldGenerationBytes = lastObservedOldGenerationAfterGcBytes;
      }
    }
  };
  const observed = new WeakSet<MessagePort>();
  const observePort = (port: MessagePort) => {
    if (observed.has(port)) {
      return;
    }
    observed.add(port);
    port.on("message", (message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        !("input" in message) ||
        "responseId" in message ||
        !("taskId" in message) ||
        typeof message.taskId !== "number"
      ) {
        return;
      }
      const input = message.input;
      if (
        !input ||
        typeof input !== "object" ||
        !("kind" in input) ||
        typeof input.kind !== "string"
      ) {
        return;
      }
      if (!observedFirstTask) {
        observedFirstTask = true;
        // Direct-parent pools have no ready reply; first dispatch proves the entry loaded.
        write({
          kind: "startup",
          startupElapsedMs: Date.now() - Number(process.env.OPENCLAW_BENCH_WORKER_STARTED_AT),
          firstTaskKind: input.kind,
          memory: sample(),
        });
      }
      drainGc();
      const before = sample();
      if (
        process.env.OPENCLAW_BENCH_WORKER_PROFILE === "1" &&
        (input.kind === "compaction-source" || input.kind === "transcript-hydration")
      ) {
        cpuProfiler = new Session();
        cpuProfiler.connect();
        cpuProfiler.post("Profiler.enable");
        cpuProfiler.post("Profiler.start");
      }
      active = {
        taskId: message.taskId,
        kind: kinds.has(input.kind) ? input.kind : "other",
        // Compaction plans and later summary-input renderings may be separate tasks.
        ...("phase" in input && typeof input.phase === "string" ? { phase: input.phase } : {}),
        startedAt: performance.now(),
        before,
        observedPeakHeapUsed: before.heapUsed,
        parsedBytes: 0,
        parseCount: 0,
        parseStacks: {},
        majorGcCount: 0,
      };
    });
    const post = port.postMessage.bind(port);
    port.postMessage = (
      ...args: [
        message: unknown,
        options?: Parameters<MessagePort["postMessage"]>[1] | Transferable[],
      ]
    ) => {
      const message: unknown = args[0];
      if (
        active?.kind === "compaction-source" &&
        message &&
        typeof message === "object" &&
        "status" in message &&
        (message.status === "request" || message.status === "ok") &&
        "value" in message &&
        message.value &&
        typeof message.value === "object"
      ) {
        // Held-snapshot sources send requests; short tasks return the same reply in their result.
        const result = message.value as Record<string, unknown>;
        const value = (
          message.status === "ok" && result.reply && typeof result.reply === "object"
            ? result.reply
            : result
        ) as Record<string, unknown>;
        if (value.kind === "prepared" && value.plan && typeof value.plan === "object") {
          const plan = value.plan as { retained: unknown[] };
          write({
            kind: "compaction-prepared",
            retainedEntries: plan.retained.length,
            retainedJsonBytes: Buffer.byteLength(JSON.stringify(plan.retained)),
          });
        } else if (
          value.kind === "serialized" &&
          value.conversation &&
          typeof value.conversation === "object"
        ) {
          const conversation = value.conversation as { text: string };
          write({ kind: "compaction-serialized", summaryInputChars: conversation.text.length });
        }
      }
      if (
        active &&
        message &&
        typeof message === "object" &&
        "taskId" in message &&
        message.taskId === active.taskId &&
        "status" in message &&
        (message.status === "ok" || message.status === "failed")
      ) {
        drainGc();
        const after = sample();
        write({
          kind: active.kind,
          ...(active.phase ? { phase: active.phase } : {}),
          status: message.status,
          elapsedMs: performance.now() - active.startedAt,
          before: active.before,
          after,
          observedPeakHeapUsed: Math.max(active.observedPeakHeapUsed, after.heapUsed),
          parsedBytes: active.parsedBytes,
          ...(process.env.OPENCLAW_BENCH_WORKER_PROFILE === "1"
            ? { parseStacks: active.parseStacks }
            : {}),
          majorGcCount: active.majorGcCount,
          postMajorGcOldGenerationBytes: active.postMajorGcOldGenerationBytes,
        });
        const cpu = cpuProfiler;
        if (cpu) {
          const profilePath = path.join(
            output,
            `worker-${threadId}-task-${active.taskId}.cpuprofile`,
          );
          cpu.post("Profiler.stop", (error, result) => {
            if (error) {
              write({ kind: "profile-error", message: error.message });
            } else {
              writeFileSync(profilePath, JSON.stringify(result.profile));
            }
            cpu.disconnect();
          });
          cpuProfiler = undefined;
        }
        lastKind = active.kind;
        active = undefined;
      }
      return Reflect.apply(post, undefined, args);
    };
  };
  // Observe the startup port before the worker entry attaches its listener, then
  // follow the task port it transfers. Each native method keeps its own receiver.
  if (parentPort) {
    observePort(parentPort);
    parentPort.on("message", (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "openclaw.worker-task-port" &&
        "port" in message &&
        message.port instanceof MessagePort
      ) {
        observePort(message.port);
      }
    });
  }
  const parse = JSON.parse;
  JSON.parse = function (...args: [text: string, reviver?: Parameters<typeof JSON.parse>[1]]) {
    const value = Reflect.apply(parse, undefined, args);
    if (active && typeof args[0] === "string" && args[0].length >= 1024) {
      active.parsedBytes += Buffer.byteLength(args[0]);
      if (process.env.OPENCLAW_BENCH_WORKER_PROFILE === "1" && active.parseCount++ % 64 === 0) {
        const stack = new Error().stack?.split("\n").slice(2).join("\n") ?? "unknown";
        active.parseStacks[stack] = (active.parseStacks[stack] ?? 0) + 1;
      }
      active.observedPeakHeapUsed = Math.max(
        active.observedPeakHeapUsed,
        process.memoryUsage().heapUsed,
      );
    }
    return value;
  };
  setInterval(() => {
    drainGc();
    write({ kind: "sample", memory: sample() });
  }, 1000).unref();
}
