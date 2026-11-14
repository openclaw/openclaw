// Benchmark-only native COMMIT timing. Shared histograms survive worker retirement.
// Worker preload propagation follows worker-retained-heap-preload.ts; no production factory changes.
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createHistogram, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import workerThreads, {
  BroadcastChannel,
  getEnvironmentData,
  isMainThread,
  setEnvironmentData,
  threadId,
} from "node:worker_threads";

const key = "openclaw.benchmark.agent-exec-io-workers";
const shared = isMainThread
  ? {
      gate: new Int32Array(new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT)),
      histogram: createHistogram(),
      channel: `${key}-${process.pid}`,
    }
  : getEnvironmentData(key);
if (!shared) {
  throw new Error("IO worker instrumentation requires its benchmark owner");
}
if (isMainThread) {
  setEnvironmentData(key, shared);
}
// gate: measuring, in-flight calls, failures, loaded preloads, constructed workers, eval workers.
const { gate, histogram } = shared;
const channel = new BroadcastChannel(shared.channel);
channel.unref();
const announce = channel.postMessage.bind(channel);
const identities = new Map();
let startedAtEpochMs;
let workersAtStart;
if (isMainThread) {
  channel.addEventListener("message", ({ data }) => {
    let identity = identities.get(data.threadId);
    if (!identity) {
      identity = {
        threadId: data.threadId,
        script: data.script,
        instrumentedAtEpochMs: data.instrumentedAtEpochMs,
        measuredCommit: false,
        owners: new Set(),
      };
      identities.set(data.threadId, identity);
    }
    if (data.owner) {
      identity.owners.add(data.owner);
    }
    identity.measuredCommit ||= data.measuredCommit === true;
  });
} else {
  Atomics.add(gate, 3, 1);
  const identity = {
    threadId,
    script: path.basename(process.argv[1] ?? ""),
    instrumentedAtEpochMs: Date.now(),
  };
  let reportedMeasuredCommit = false;
  announce(identity);
  // sqlite-store workers load their actual database owner after the physical thread starts.
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:")) {
        return result;
      }
      const basename = path.basename(new URL(url).pathname);
      if (/\.worker\.[cm]?[jt]s$/u.test(basename)) {
        announce({ ...identity, owner: basename });
      }
      return result;
    },
  });
  // Captured native functions require an explicit database receiver at invocation.
  /** @type {{ exec: (this: DatabaseSync, sql: string) => void }} */
  const nativePrototype = DatabaseSync.prototype;
  const original = nativePrototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (Atomics.load(gate, 0) !== 1 || !/^\s*COMMIT(?:\s+TRANSACTION)?\s*;?\s*$/iu.test(sql)) {
      return original.call(this, sql);
    }
    Atomics.add(gate, 1, 1);
    // A stop between admission and entry must not create a new measured call.
    if (Atomics.load(gate, 0) !== 1) {
      Atomics.sub(gate, 1, 1);
      return original.call(this, sql);
    }
    if (!reportedMeasuredCommit) {
      announce({ ...identity, measuredCommit: true });
      reportedMeasuredCommit = true;
    }
    const started = performance.now();
    try {
      return original.call(this, sql);
    } catch (error) {
      Atomics.add(gate, 2, 1);
      throw error;
    } finally {
      histogram.record(Math.max(1, Math.round((performance.now() - started) * 1000)));
      Atomics.sub(gate, 1, 1);
    }
  };
}

// Explicit execArgv=[] otherwise drops the Gateway's instrumentation in built workers.
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const execArgv = options.execArgv ?? process.execArgv;
    super(filename, {
      ...options,
      execArgv: execArgv.includes(import.meta.url)
        ? execArgv
        : [...execArgv, "--import", import.meta.url],
    });
    Atomics.add(gate, 4, 1);
    if (options.eval) {
      // Node does not run --import preloads for CommonJS eval workers.
      Atomics.add(gate, 5, 1);
    }
  }
};
syncBuiltinESMExports();

export function startWorkerCommitMeasurement() {
  histogram.reset();
  Atomics.store(gate, 2, 0);
  workersAtStart = Atomics.load(gate, 3);
  startedAtEpochMs = Date.now();
  Atomics.store(gate, 0, 1);
}

export async function stopWorkerCommitMeasurement() {
  Atomics.store(gate, 0, 2);
  const endedAtEpochMs = Date.now();
  const inFlightAtStop = Atomics.load(gate, 1);
  // Keep complete pauses for calls admitted within the window, including its final boundary.
  const deadline = Date.now() + 45_000;
  while (Atomics.load(gate, 1) > 0 && Date.now() < deadline) {
    await delay(10);
  }
  // Deliver queued startup/backend identities before sealing coverage.
  await delay(0);
  return {
    scope:
      "Pooled same-process Node file/module worker DatabaseSync.exec explicit COMMIT attempts started within the shared gate; includes failures and full boundary-crossing calls. Excludes main thread, implicit commits, multi-statement SQL, CommonJS eval workers, and subprocess database owners.",
    startedAtEpochMs,
    endedAtEpochMs,
    collectedAtEpochMs: Date.now(),
    complete: Atomics.load(gate, 1) === 0,
    inFlightAtStop,
    inFlightRemaining: Atomics.load(gate, 1),
    samples: histogram.count,
    failures: Atomics.load(gate, 2),
    p50Ms: histogram.count ? histogram.percentile(50) / 1000 : null,
    p95Ms: histogram.count ? histogram.percentile(95) / 1000 : null,
    p99Ms: histogram.count ? histogram.percentile(99) / 1000 : null,
    maxMs: histogram.count ? histogram.max / 1000 : null,
    instrumentedWorkersAtStart: workersAtStart,
    instrumentedWorkersAtStop: Atomics.load(gate, 3),
    coverageCountsScope:
      "Cumulative worker constructions/preload installations; identities mark workers observed entering a measured COMMIT, including workers retired before collection.",
    constructedWorkers: Atomics.load(gate, 4),
    excludedEvalWorkers: Atomics.load(gate, 5),
    identities: [...identities.values()].map((identity) => ({
      threadId: identity.threadId,
      script: identity.script,
      instrumentedAtEpochMs: identity.instrumentedAtEpochMs,
      measuredCommit: identity.measuredCommit,
      owners: [...identity.owners].toSorted((left, right) => left.localeCompare(right)),
    })),
  };
}
