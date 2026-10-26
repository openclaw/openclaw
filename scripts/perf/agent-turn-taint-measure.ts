/**
 * Measure current-turn taint lookup over 10,000 synthetic historical messages.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-turn-taint-measure.ts --mode timing --iterations 3000
 * Repeat with --mode allocation, alternating base/candidate for five pairs.
 * --owner /absolute/path/turn-taint.ts loads a saved, unchanged baseline owner.
 * Fixtures are outside measurement; results must remain true for the network
 * tail and false after the next user message. Accept lower allocation with
 * stable CPU. This measures turn setup, not per-event or Gateway performance.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
const owner = values.owner
  ? pathToFileURL(resolve(values.owner)).href
  : new URL("../../packages/agent-core/src/turn-taint.ts", import.meta.url).href;
const { isActiveTurnTainted }: typeof import("../../packages/agent-core/src/turn-taint.js") =
  await import(owner);
const history: AgentMessage[] = Array.from({ length: 10000 }, (_, index) => ({
  role: "user",
  content: `synthetic history ${index}`,
  timestamp: index,
}));
const current: AgentMessage = { role: "user", content: "current turn", timestamp: 10001 };
const network = {
  role: "toolResult" as const,
  toolCallId: "synthetic-call",
  toolName: "synthetic-tool",
  content: [{ type: "text" as const, text: "synthetic network content" }],
  isError: false,
  timestamp: 10002,
  __openclaw: { resultContentSource: "network" },
};
const fixtures = [
  [...history, current, network],
  [...history, network, current],
];
let matches = 0;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    matches += Number(isActiveTurnTainted(fixtures[index % 2]!));
  }
}
run(1000);
matches = 0;
globalThis.gc?.();
const session = new Session();
if (values.mode === "allocation") {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpu = process.threadCpuUsage();
const start = performance.now();
run(iterations);
const elapsedMs = performance.now() - start;
const used = process.threadCpuUsage(cpu);
let bytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  session.disconnect();
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  bytes = sum(profile.head);
}
assert.equal(matches, Math.ceil(iterations / 2));
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    history: history.length,
    matches,
    hostLoad,
    elapsedMs,
    cpuNsPerScan: ((used.user + used.system) * 1000) / iterations,
    allocatedBytesPerScan: bytes === undefined ? undefined : bytes / iterations,
  }),
);
