/**
 * Run unchanged on base/candidate in counterbalanced order:
 * node --import ./scripts/tsx.mjs scripts/perf/worker-lifecycle-message-measure.ts timing
 * node --import ./scripts/tsx.mjs scripts/perf/worker-lifecycle-message-measure.ts allocation
 *
 * Census: one real supervisor and 48 real synthetic echo workers, labeled with
 * Team's worker mix (7 transcript, 9 code-mode, 5 git, 3 sqlite-store, 24 other).
 * These labels do not load the corresponding domain implementations. Validate
 * 100 ordered 1-KiB echoes per worker, then capture actual terminal receipts.
 *
 * Owner replay: five 5k-retirement passes in waves of 48 fresh NativeWorker
 * handles. Replay the observed receipts through a real loopback MessageChannel
 * and synchronous native-port reads. Includes handle creation, cloning, sends,
 * owner receipt handling, and release; excludes real worker startup and event
 * callback wakeups. This is owner cost, not whole-Gateway throughput or a live
 * Team rate. Allocation sampling is a separate pass and includes collected
 * objects. GC timing is authoritative only in untraced timing mode.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver, type PerformanceNodeEntry } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveRuntimeWorkerThreadExecArgv } from "../../src/infra/runtime-worker-url.ts";
import { NativeWorker } from "../../src/infra/worker-native-handle.ts";
import type {
  NativeWorkerReply,
  NativeWorkerRequest,
  NativeWorkerRuntime,
} from "../../src/infra/worker-native-lifecycle.types.ts";

const mode = process.argv[2] ?? "timing";
assert(mode === "timing" || mode === "allocation");
const iterations = 5_000;
const workerMix = { "session-transcript": 7, "code-mode": 9, git: 5, "sqlite-store": 3, other: 24 };
const labels = Object.entries(workerMix).flatMap(([label, count]) =>
  Array<string>(count).fill(label),
);
const supervisorUrl = new URL("../../src/infra/worker-native-lifecycle.worker.ts", import.meta.url);
const childUrl = `data:text/javascript,${encodeURIComponent(
  'import {parentPort} from "node:worker_threads"; parentPort.on("message", value => parentPort.postMessage(value));',
)}`;

async function census() {
  const { port1, port2 } = new MessageChannel();
  const supervisor = new Worker(supervisorUrl, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(supervisorUrl),
    workerData: { port: port2 },
    transferList: [port2],
  });
  const counts: Record<string, number> = {};
  const terminals = new Map<number, NativeWorkerReply[]>();
  const echoes = new Map<number, number>();
  let created = 0;
  let stopped = 0;
  let responseBytes = 0;
  let notify: (() => void) | undefined;
  let failure: Error | undefined;
  const count = (direction: string, type: string) => {
    const key = `${direction}:${type}`;
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const post = (request: NativeWorkerRequest) => {
    count("to_worker", request.type);
    port1.postMessage(request);
  };
  const fail = (error: unknown) => {
    failure = toErrorObject(error, "Supervisor census failed");
    notify?.();
  };
  supervisor.on("error", fail);
  port1.on("messageerror", fail);
  port1.on("message", (reply: NativeWorkerReply) => {
    try {
      count("from_worker", reply.type);
      if (reply.type === "created") {
        created++;
      } else if (reply.type === "message") {
        assert(reply.value instanceof Uint8Array);
        const expected = new Uint8Array(1024).fill(reply.id);
        new DataView(expected.buffer).setUint32(0, echoes.get(reply.id) ?? 0);
        assert.deepEqual(reply.value, expected);
        echoes.set(reply.id, (echoes.get(reply.id) ?? 0) + 1);
        responseBytes += reply.value.byteLength;
      } else if (reply.type === "execution-exit" || reply.type === "stopped") {
        const sequence = terminals.get(reply.id) ?? [];
        sequence.push(reply);
        terminals.set(reply.id, sequence);
        if (reply.type === "stopped") {
          stopped++;
          post({ type: "release", id: reply.id });
        }
      } else {
        assert.fail(`Unexpected supervisor reply: ${reply.type}`);
      }
      notify?.();
    } catch (error) {
      fail(error);
    }
  });
  const until = (done: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => fail(new Error("Supervisor census timed out")), 60_000);
      notify = () => {
        if (failure || done()) {
          clearTimeout(timeout);
          notify = undefined;
          if (failure) {
            reject(failure);
          } else {
            resolve();
          }
        }
      };
      notify();
    });
  const start = performance.now();
  try {
    for (let id = 1; id <= labels.length; id++) {
      post({
        type: "create",
        id,
        filename: { kind: "url", value: childUrl },
        environmentData: [],
        options: { environment: {}, shareEnvironment: true, execArgv: [] },
        transferList: [],
      });
    }
    await until(() => created === labels.length);
    const startupMs = performance.now() - start;
    const echoStart = performance.now();
    for (let sequence = 0; sequence < 100; sequence++) {
      for (let id = 1; id <= labels.length; id++) {
        const value = new Uint8Array(1024).fill(id);
        new DataView(value.buffer).setUint32(0, sequence);
        post({ type: "post", id, value, transferList: [] });
      }
    }
    await until(() => responseBytes === labels.length * 100 * 1024);
    const echoMs = performance.now() - echoStart;
    const retirementStart = performance.now();
    for (let id = 1; id <= labels.length; id++) {
      post({ type: "stop", id });
    }
    await until(() => stopped === labels.length);
    const retirementMs = performance.now() - retirementStart;
    const sequence = terminals.get(1)!;
    for (const actual of terminals.values()) {
      assert.deepEqual(
        actual.map((reply) => reply.type),
        sequence.map((reply) => reply.type),
      );
    }
    const elapsedMs = performance.now() - start;
    return {
      sequence,
      report: {
        workerMix,
        syntheticDomainLabelsOnly: true,
        startupMs,
        echoMs,
        retirementMs,
        elapsedMs,
        responseBytes,
        counts,
        observedPerMinute: Object.fromEntries(
          Object.entries(counts).map(([key, value]) => [key, (value * 60_000) / elapsedMs]),
        ),
        terminalSequence: sequence.map((reply) => reply.type),
      },
    };
  } finally {
    port1.close();
    await supervisor.terminate();
  }
}

const observed = await census();
const channel = new MessageChannel();
const handles = new Map<number, NativeWorker>();
let releases = 0;
let references = false;
const runtime: NativeWorkerRuntime = {
  handles,
  service() {},
  post(message) {
    assert.equal(message.type, "release");
    releases++;
  },
  refreshReference() {
    references = [...handles.values()].some((handle) => handle.needsReference);
  },
  resourceBroker() {
    throw new Error("Synthetic workers have no retained native resources");
  },
};
async function replay(count: number) {
  const before = releases;
  for (let offset = 0; offset < count; offset += labels.length) {
    const wave = Math.min(labels.length, count - offset);
    for (let id = 1; id <= wave; id++) {
      const handle = new NativeWorker(runtime, id, childUrl, false, false);
      handles.set(id, handle);
      handle.receive({ type: "created", id, threadId: id });
      for (const reply of observed.sequence) {
        channel.port1.postMessage({ ...reply, id });
      }
    }
    for (
      let message = receiveMessageOnPort(channel.port2);
      message;
      message = receiveMessageOnPort(channel.port2)
    ) {
      const reply: NativeWorkerReply = message.message;
      handles.get(reply.id)!.receive(reply);
    }
    assert.equal(handles.size, 0);
    assert.equal(references, false);
    await setImmediate();
  }
  assert.equal(releases - before, count);
}

function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
const inspector = new Session();
const collections: { kind: number; ms: number }[] = [];
const observer = new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) {
    collections.push({ kind: (entry as PerformanceNodeEntry).detail.kind, ms: entry.duration });
  }
});
try {
  await replay(iterations);
  await setImmediate();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const runs = [];
  for (let pass = 0; pass < 5; pass++) {
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    await replay(iterations);
    const used = process.threadCpuUsage(cpu);
    runs.push({
      iterations,
      elapsedMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000,
      hostLoad,
    });
  }
  await setImmediate();
  const profile =
    mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  console.log(
    JSON.stringify({
      mode,
      census: observed.report,
      replay: {
        runs,
        iterations: iterations * runs.length,
        terminalMessages: iterations * runs.length * observed.sequence.length,
        sampledAllocatedBytes: profile ? allocated(profile.profile.head) : undefined,
        gc: {
          count: collections.length,
          totalMs: collections.reduce((sum, entry) => sum + entry.ms, 0),
          maxMs: Math.max(0, ...collections.map((entry) => entry.ms)),
          byKind: Object.fromEntries(
            [...new Set(collections.map((entry) => entry.kind))].map((kind) => {
              const samples = collections.filter((entry) => entry.kind === kind);
              return [
                kind,
                {
                  count: samples.length,
                  totalMs: samples.reduce((sum, entry) => sum + entry.ms, 0),
                  maxMs: Math.max(0, ...samples.map((entry) => entry.ms)),
                },
              ];
            }),
          ),
        },
        memory: process.memoryUsage(),
        hostLoad: loadavg(),
      },
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  channel.port1.close();
  channel.port2.close();
}
