/**
 * Typing-owner benchmark: 64 concurrent turns, 256 text deltas each, tool activity
 * every eighth delta. Runs the real signaler/controller; no network or live state.
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/typing-timer-churn.ts --mode timing
 * Use --mode allocation or --mode counts in separate passes. --mode cpu repeats
 * the workload 64 times for diagnostic timer-internal CPU samples. --owner <module>
 * selects an unchanged owner for AB/BA comparisons; imports must resolve normally.
 * Acceptance: one TTL timer/turn, identical start/cleanup counts and lower CPU or
 * allocation per delta. This is channel typing work, not internal-webchat traffic.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createTypingSignaler } from "../../src/auto-reply/reply/typing-mode.js";
import type { createTypingController } from "../../src/auto-reply/reply/typing.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    owner: { type: "string", default: "src/auto-reply/reply/typing.ts" },
  },
});
assert(["timing", "allocation", "counts", "cpu"].includes(values.mode));
const owner: { createTypingController: typeof createTypingController } = await import(
  pathToFileURL(resolve(values.owner)).href
);
const turns = 64;
const deltas = 256;
async function run() {
  let starts = 0;
  let cleanups = 0;
  await Promise.all(
    Array.from({ length: turns }, async () => {
      const controller = owner.createTypingController({
        onReplyStart: () => {
          starts++;
        },
        onCleanup: () => {
          cleanups++;
        },
      });
      const signaler = createTypingSignaler({ typing: controller, mode: "instant" });
      try {
        await signaler.signalRunStart();
        for (let index = 0; index < deltas; index++) {
          await signaler.signalTextDelta("synthetic text");
          if (index % 8 === 7) {
            await signaler.signalToolStart();
          }
        }
        controller.markRunComplete();
        controller.markDispatchIdle();
      } finally {
        controller.cleanup();
      }
    }),
  );
  assert.equal(starts, turns);
  assert.equal(cleanups, turns);
}
await run();
globalThis.gc?.();
const inspector = ["allocation", "cpu"].includes(values.mode) ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  if (values.mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
}
const originals = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const counts = { setTimeout: 0, clearTimeout: 0 };
if (values.mode === "counts") {
  const counted = <T extends typeof setTimeout | typeof clearTimeout>(
    name: keyof typeof counts,
    original: T,
  ) =>
    new Proxy(original, {
      apply(target, receiver, args) {
        counts[name]++;
        return Reflect.apply(target, receiver, args);
      },
    });
  globalThis.setTimeout = counted("setTimeout", originals.setTimeout);
  globalThis.clearTimeout = counted("clearTimeout", originals.clearTimeout);
}
const hostLoadBefore = loadavg();
const beforeCpu = process.threadCpuUsage();
const started = performance.now();
const repetitions = values.mode === "cpu" ? 64 : 1;
try {
  for (let repetition = 0; repetition < repetitions; repetition++) {
    await run();
  }
} finally {
  Object.assign(globalThis, originals);
}
const elapsedMs = performance.now() - started;
const cpu = process.threadCpuUsage(beforeCpu);
let sampledBytes: number | undefined;
let timerCpuSamples: number | undefined;
let cpuSamples: number | undefined;
if (inspector) {
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
  } else {
    const { profile } = await inspector.post("Profiler.stop");
    const timerNodes = new Set(
      profile.nodes
        .filter((node) => /^node:(?:internal\/)?timers$/.test(node.callFrame.url))
        .map((node) => node.id),
    );
    cpuSamples = profile.samples?.length ?? 0;
    timerCpuSamples = profile.samples?.filter((id) => timerNodes.has(id)).length ?? 0;
  }
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode: values.mode,
    owner: values.owner,
    turns,
    deltas,
    repetitions,
    events: turns * deltas * repetitions,
    elapsedMs,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    timerCpuSamples,
    cpuSamples,
    counts: values.mode === "counts" ? counts : undefined,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
