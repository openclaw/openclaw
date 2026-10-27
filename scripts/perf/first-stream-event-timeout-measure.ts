/**
 * First-event deadline owner benchmark; synthetic Responses events, no network.
 * node --import ./scripts/tsx.mjs scripts/perf/first-stream-event-timeout-measure.ts
 *   <cpu|allocation|promises> [owner-module-url] [turns=2000] [events=300]
 * Use separate CPU/allocation passes and five counterbalanced revision pairs.
 * Compare one-event streams as well as 300-event streams: cleanup is once per
 * stream, so this does not predict a per-event or whole-Gateway improvement.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { promiseHooks } from "node:v8";
import type { withFirstStreamEventTimeout as Wrap } from "../../packages/ai/src/utils/stream-first-event-timeout.js";

const mode = process.argv[2] ?? "cpu";
assert(["cpu", "allocation", "promises"].includes(mode));
const { withFirstStreamEventTimeout }: { withFirstStreamEventTimeout: typeof Wrap } = await import(
  process.argv[3] ?? "../../packages/ai/src/utils/stream-first-event-timeout.js"
);
const turns = Number(process.argv[4] ?? 2_000);
const events = Number(process.argv[5] ?? 300);
assert(Number.isSafeInteger(turns) && turns > 0);
assert(Number.isSafeInteger(events) && events > 0);
const event = { type: "response.output_text.delta", delta: "Synthetic streamed text." };

async function run(count: number) {
  let received = 0;
  for (let turn = 0; turn < count; turn++) {
    async function* source() {
      for (let index = 0; index < events; index++) {
        yield event;
      }
    }
    for await (const next of withFirstStreamEventTimeout(source(), { timeoutMs: 120_000 })) {
      assert.equal(next, event);
      received++;
    }
  }
  assert.equal(received, count * events);
}

await run(200);
await setImmediate();
const inspector = new Session();
if (mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: events === 1 ? 512 : 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
let promises = 0;
const stop = mode === "promises" ? promiseHooks.createHook({ init: () => promises++ }) : undefined;
let gcMs = 0;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcMs += entry.duration;
  }
});
observer.observe({ entryTypes: ["gc"] });
const hostLoad = loadavg();
const cpu = process.threadCpuUsage();
const started = performance.now();
await run(turns);
const wallMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
stop?.();
await setImmediate();
await setImmediate();
observer.disconnect();
let sampledBytes: number | undefined;
if (mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    node: process.version,
    mode,
    turns,
    events,
    mainThreadCpuMs: (used.user + used.system) / 1_000,
    wallMs,
    sampledBytes,
    promises: mode === "promises" ? promises : undefined,
    gcMs,
    hostLoad,
    memory: process.memoryUsage(),
  }),
);
