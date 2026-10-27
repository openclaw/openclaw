/**
 * Tool-result sizing owner benchmark (no Gateway latency claim).
 * 200 messages / 60 CJK tool results; reuse frozen content with fresh request arrays.
 * Each request applies history limits and estimates compaction savings. Change one
 * result every 20 requests to include cold admission. Compare five alternating
 * base/candidate runs, separately for timing and sampled allocation (includes GC).
 * Accept unchanged bytes/decisions and lower CPU or allocation without a material
 * adverse timing/GC change. Small tail samples are descriptive only.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-result-size-measure.ts \
 *   --owner /path/to/tool-result-truncation.ts --mode timing --iterations 3000
 * Repeat with --mode allocation. A baseline owner snapshot must be placed beside
 * its original siblings so both revisions use identical unchanged dependencies.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
  },
});
assert(["timing", "allocation"].includes(values.mode));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 3000,
});
const owner = values.owner
  ? pathToFileURL(values.owner)
  : new URL("../../src/agents/embedded-agent-runner/tool-result-truncation.ts", import.meta.url);
const {
  truncateOversizedToolResultsInMessages,
  estimateToolResultReductionPotential,
}: typeof import("../../src/agents/embedded-agent-runner/tool-result-truncation.js") = await import(
  owner.href
);
const payload = "synthetic output 漢字 𠀀 🙂\n".repeat(128);
function tool(index: number, revision: number): AgentMessage {
  return freezeTrustedJsonSnapshot({
    role: "toolResult",
    toolName: "read",
    toolCallId: `call-${index}`,
    content: [{ type: "text", text: `${index}:${revision}\n${payload}` }],
    isError: false,
    timestamp: index,
  });
}
const history: AgentMessage[] = Array.from({ length: 200 }, (_, i) =>
  i % 3 === 0 && i < 180 ? tool(i, 0) : { role: "user", content: "Continue", timestamp: i },
);
const contextWindowTokens = 1_000_000;
function run(index: number) {
  if (index % 20 === 0) {
    const position = ((index / 20) % 60) * 3;
    history[position] = tool(position, index);
  }
  const messages = [...history];
  const result = truncateOversizedToolResultsInMessages(messages, contextWindowTokens);
  const potential = estimateToolResultReductionPotential({ messages, contextWindowTokens });
  assert.equal(result.messages, messages);
  assert.equal(result.truncatedCount, 0);
  assert.equal(potential.maxReducibleChars, 0);
}
for (let i = 0; i < 200; i++) {
  run(i);
}
global.gc?.();
await nextTurn();
const gcPauses: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcPauses.push(entry.duration);
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  run(i + 200);
  if (i % 100 === 0) {
    await nextTurn();
  }
}
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
await nextTurn();
await nextTurn();
observer.disconnect();
let sampledBytes: number | null = null;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode: values.mode,
    owner: owner.href,
    iterations,
    messages: 200,
    toolResults: 60,
    hostLoad,
    elapsedMs,
    cpuMsPerRequest: (cpu.user + cpu.system) / 1000 / iterations,
    allocationBytesPerRequest: sampledBytes === null ? null : sampledBytes / iterations,
    gcCount: gcPauses.length,
    gcMsPerRequest: gcPauses.reduce((a, b) => a + b, 0) / iterations,
    gcMaxMs: Math.max(0, ...gcPauses),
    memory: process.memoryUsage(),
  }),
);
