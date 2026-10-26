/**
 * Owner microbenchmark for cron source-kind checks and progress diff-stat equality.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/source-kind-progress-equality-measure.ts
 * Add --allocations for a separate sampled-allocation pass (includes collected objects).
 * --cron-owner /absolute/base.ts and --progress-owner /absolute/base.ts load saved
 * base owner sources through the same import graph, without a second installation.
 * Run base/candidate in alternating order; fixtures/imports/warmup are not measured.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CronJob } from "../../src/cron/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    "cron-owner": { type: "string" },
    "progress-owner": { type: "string" },
    iterations: { type: "string", default: "5000" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 5000,
  min: 1,
  label: "iterations",
});
const replacements = new Map<string, string>();
for (const [option, owner] of [
  [values["cron-owner"], "../../src/cron/service/jobs-scheduling.ts"],
  [values["progress-owner"], "../../src/channels/progress-draft-compositor.ts"],
] as const) {
  if (option) {
    replacements.set(new URL(owner, import.meta.url).href, pathToFileURL(option).href);
  }
}
const loaded = new Set<string>();
registerHooks({
  load(url, context, nextLoad) {
    const replacement = replacements.get(url);
    if (!replacement) {
      return nextLoad(url, context);
    }
    loaded.add(url);
    const result = nextLoad(replacement, context);
    return { format: result.format, source: result.source, shortCircuit: true };
  },
});
const { recomputeSingleJobForMaintenance } =
  await import("../../src/cron/service/jobs-scheduling.js");
const { createChannelProgressDraftCompositor } =
  await import("../../src/channels/progress-draft-compositor.js");
assert.equal(loaded.size, replacements.size, "Every requested base owner must load");

const jobs: CronJob[] = Array.from({ length: 40 }, (_, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic source ${index}`,
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  sessionTarget: "main",
  wakeMode: "now",
  payload: { kind: "systemEvent", text: "Synthetic notification" },
  schedule:
    index % 2 === 0
      ? {
          kind: "event",
          source: `plugin-${index}`,
          options: {
            topics: Array.from({ length: 20 }, (_topic, topic) => `synthetic/topic/${topic}`),
            filter: { account: `account-${index}`, labels: ["updates", "automations"] },
          },
        }
      : { kind: "stream", command: ["synthetic-source", "--topic", String(index)], mode: "line" },
  state: { sourceIdentity: `event-${index}`, streamSourceIdentity: `stream-${index}` },
}));
const noop = () => {};
const state = {
  deps: { nowMs: () => 1_000, log: { debug: noop, info: noop, warn: noop, error: noop } },
};
const options = { nowMs: 1_000, deferredNotifications: [] };
const ownership = { reservations: new Map(), isJobActive: () => false };
const progress = createChannelProgressDraftCompositor({
  active: true,
  mode: "progress",
  seed: "synthetic",
  entry: {
    streaming: { mode: "progress", progress: { toolProgress: true, label: false, maxLines: 1 } },
  },
  initialSnapshot: { lines: ["Exec"], diffStat: { files: 40, added: 120, removed: 35 } },
  updateOnLineChange: true,
  update: () => true,
});
await progress.noteActivity({ startImmediately: true });
const workloads = {
  cron: async (count: number) => {
    for (let index = 0; index < count; index++) {
      assert.equal(
        recomputeSingleJobForMaintenance(state, jobs[index % jobs.length]!, options, ownership),
        false,
      );
    }
  },
  progress: async (count: number) => {
    for (let index = 0; index < count; index++) {
      assert.equal(await progress.pushToolProgress("Exec", { startImmediately: true }), false);
    }
  },
};
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
try {
  for (const [workload, run] of Object.entries(workloads)) {
    await run(1000);
    globalThis.gc?.();
    const inspector = new Session();
    if (values.allocations) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    await run(iterations);
    const wallMs = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    let allocatedBytes: number | undefined;
    if (values.allocations) {
      allocatedBytes = sampledBytes(
        (await inspector.post("HeapProfiler.stopSampling")).profile.head,
      );
      inspector.disconnect();
    }
    console.log(
      JSON.stringify({
        workload,
        iterations,
        mode: values.allocations ? "allocation" : "timing",
        cpuMs: (used.user + used.system) / 1000,
        wallMs,
        allocatedBytes,
        hostLoad,
        rss: process.memoryUsage().rss,
        heapUsed: process.memoryUsage().heapUsed,
      }),
    );
  }
} finally {
  progress.cancel();
}
