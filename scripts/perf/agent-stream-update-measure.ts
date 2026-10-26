/**
 * Provider-update owner probe (1,000 history entries, 40 tools; no live services).
 * Run unchanged on base and candidate, alternating order for at least five pairs:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --mode timing
 * Repeat with --mode allocation; timing under the sampler is diagnostic only.
 * --snapshots false exercises partial-free text deltas instead of checkpoints.
 * Accept lower allocation/update with stable CPU and identical delivery counts;
 * this measures the real agent loop, not whole-Gateway throughput or latency.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { runAgentLoop } from "../../packages/agent-core/src/agent-loop.js";
import {
  config,
  makeAssistantMessage,
  makeTool,
  user,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import type { AssistantMessageEvent } from "../../packages/llm-core/src/types.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    events: { type: "string", default: "20000" },
    turns: { type: "string", default: "10" },
    snapshots: { type: "string", default: "true" },
  },
});
const events = Number(values.events);
const turns = Number(values.turns);
assert(Number.isSafeInteger(events) && events > 0);
assert(Number.isSafeInteger(turns) && turns > 0);
assert(values.mode === "timing" || values.mode === "allocation");
assert(values.snapshots === "true" || values.snapshots === "false");
const snapshots = values.snapshots === "true";
const message = makeAssistantMessage(
  snapshots ? [{ type: "thinking", thinking: "synthetic thought" }] : [],
);
const update: AssistantMessageEvent = snapshots
  ? { type: "thinking_delta", contentIndex: 0, delta: "x", partial: message }
  : { type: "text_delta", contentIndex: 0, delta: "x" };
const finalMessage = snapshots
  ? message
  : makeAssistantMessage([{ type: "text", text: "x".repeat(events) }]);
const history = Array.from({ length: 1000 }, (_, index) => user(`synthetic ${index}`, index));
const tools = Array.from({ length: 40 }, (_, index) => makeTool(`synthetic_${index}`));
let deliveries = 0;
async function run() {
  await runAgentLoop(
    [user()],
    { systemPrompt: "synthetic probe", messages: history, tools },
    config,
    (event) => {
      if (event.type === "message_update") {
        deliveries++;
      }
    },
    undefined,
    () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: message } as const;
        for (let index = 0; index < events; index++) {
          yield update;
        }
        yield { type: "done", reason: "stop", message: finalMessage } as const;
      },
      result: async () => finalMessage,
    }),
  );
}
await run();
deliveries = 0;
globalThis.gc?.();
const allocation = values.mode === "allocation";
const inspector = new Session();
if (allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpu = process.cpuUsage();
const start = performance.now();
for (let turn = 0; turn < turns; turn++) {
  await run();
}
const elapsedMs = performance.now() - start;
const used = process.cpuUsage(cpu);
let allocatedBytes: number | undefined;
if (allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
}
assert.equal(deliveries, events * turns);
console.log(
  JSON.stringify({
    mode: values.mode,
    snapshots,
    events,
    turns,
    deliveries,
    hostLoad,
    elapsedMs,
    cpuNsPerUpdate: ((used.user + used.system) * 1000) / deliveries,
    allocatedBytesPerUpdate: allocatedBytes === undefined ? undefined : allocatedBytes / deliveries,
  }),
);
