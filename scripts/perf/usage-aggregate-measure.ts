/**
 * Usage output owner benchmark (synthetic 10k-session state, no Gateway/DB).
 * Run each revision with the same script, interleaving base/candidate order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/usage-aggregate-measure.ts
 *   --owner <path-to-revision/src/shared/usage-aggregates.ts> --mode timing
 * Repeat with --mode allocation; --iterations defaults to 1000. Prepare an old
 * owner with git show plus its unchanged infra/session-cost-usage-totals.ts import.
 * This measures finish(), not total request latency or whole-Gateway performance.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createEmptyCostUsageTotals } from "../../src/infra/session-cost-usage-totals.js";
import type { createUsageAggregateAccumulator } from "../../src/shared/usage-aggregates.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/shared/usage-aggregates.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "1000" },
  },
});
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
assert.ok(values.mode === "timing" || values.mode === "allocation");
assert.ok(global.gc, "Run with --expose-gc");
const owner: { createUsageAggregateAccumulator: typeof createUsageAggregateAccumulator } =
  await import(pathToFileURL(path.resolve(values.owner)).href);
const accumulator = owner.createUsageAggregateAccumulator();
const totals = {
  ...createEmptyCostUsageTotals(),
  input: 100,
  output: 50,
  totalTokens: 150,
  totalCost: 0.01,
};
const latency = { count: 2, avgMs: 100, minMs: 50, maxMs: 150, p95Ms: 150 };
for (let index = 0; index < 10_000; index++) {
  const date = `2026-10-${String(28 - (index % 28)).padStart(2, "0")}`;
  const provider = `synthetic-provider-${index % 4}`;
  const model = `synthetic-model-${index % 8}`;
  accumulator.add({
    agentId: `synthetic-agent-${index % 64}`,
    channel: `synthetic-channel-${index % 4}`,
    creatorKey: `synthetic-creator-${index % 10}`,
    usage: {
      ...totals,
      firstActivity: Date.UTC(2026, 9, 1),
      messageCounts: { total: 6, user: 1, assistant: 1, toolCalls: 2, toolResults: 2, errors: 0 },
      toolUsage: {
        totalCalls: 2,
        uniqueTools: 1,
        tools: [{ name: `tool-${index % 40}`, count: 2 }],
      },
      modelUsage: [{ provider, model, count: 2, totals }],
      dailyModelUsage: [{ date, provider, model, count: 2, tokens: 150, cost: 0.01 }],
      dailyBreakdown: [{ ...totals, date, tokens: 150, cost: 0.01 }],
      dailyMessageCounts: [
        { date, total: 6, user: 1, assistant: 1, toolCalls: 2, toolResults: 2, errors: 0 },
      ],
      latency,
      dailyLatency: [{ date, ...latency }],
    },
  });
}
let checksum = 0;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const result = accumulator.finish();
    checksum += result.tools.totalCalls + result.byModel.length + result.daily.length;
  }
}
run(200);
global.gc();
const inspector = new Session();
if (values.mode === "allocation") {
  await startCollectedHeapSampling(inspector, 1024);
}
const cpu = process.cpuUsage();
const started = performance.now();
run(iterations);
const elapsedMs = performance.now() - started;
const used = process.cpuUsage(cpu);
let allocatedBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    sessions: 10_000,
    checksum,
    cpuUsPerFinish: (used.user + used.system) / iterations,
    elapsedMs,
    allocatedBytesPerFinish: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    memory: process.memoryUsage(),
    hostLoad: os.loadavg(),
  }),
);
