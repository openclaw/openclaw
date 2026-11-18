// Synthetic owner benchmark, no Gateway or provider I/O. Run each process for
// --mode stable, changed, or drop; alternate base/candidate five times per mode.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/prompt-cache-facts-measure.ts
//   --owner /absolute/owner.ts --iterations 2000 --mode stable [--allocation]
// CPU runs are untraced. Allocation runs sample collected objects separately.
// Acceptance: unchanged requests do no fact hashing; report attribution cost on
// changed/drop requests honestly. This diagnostic is not a claimed speedup.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
    mode: { type: "string", default: "stable" },
    allocation: { type: "boolean" },
  },
});
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
assert.ok(["stable", "changed", "drop"].includes(values.mode));
const {
  beginPromptCacheObservation: begin,
  completePromptCacheObservation: complete,
  collectPromptCacheTools,
  clearPromptCacheObservations: clear,
}: typeof import("../../src/agents/embedded-agent-runner/prompt-cache-observability.js") = await import(
  values.owner
    ? pathToFileURL(values.owner).href
    : "../../src/agents/embedded-agent-runner/prompt-cache-observability.js"
);
const tools = Array.from({ length: 40 }, (_, i) => ({
  name: `tool-${i}`,
  description: "Synthetic tool guidance. ".repeat(12),
  parameters: { type: "object" },
}));
const prefix = `## Skills\n${"Synthetic stable skill guidance. ".repeat(3000)}`;
const suffix = `## Tooling\n${tools.map((t) => `- ${t.name}: Synthetic tool summary`).join("\n")}\n## Conversation Context\n${"Synthetic context.\n".repeat(100)}\n## Runtime\nRuntime: model=`;
const prompts = ["fixture-a", "fixture-b"].map(
  (model) => `${prefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${suffix}${model} | channel=webchat`,
);
function observe(index: number) {
  const sessionId = `synthetic-${index % 64}`;
  const revision = values.mode === "stable" ? 0 : Math.floor(index / 64) % 2;
  begin({
    sessionId,
    provider: "openai",
    modelId: "fixture-model",
    streamStrategy: "fixture",
    systemPrompt: prompts[revision]!,
    tools: collectPromptCacheTools(tools),
    messages: [],
  });
  return complete({
    sessionId,
    usage: { input: 12_000, cacheRead: values.mode === "drop" && revision ? 2000 : 8000 },
  });
}
for (let index = 0; index < 256; index++) {
  observe(index);
}
clear();
for (let index = 0; index < 64; index++) {
  observe(index);
}
global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const inspector = values.allocation ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const started = process.cpuUsage();
let drops = 0;
for (let index = 64; index < iterations + 64; index++) {
  if (observe(index)) {
    drops++;
  }
}
const cpu = process.cpuUsage(started);
let sampledBytes = 0;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop()!;
    sampledBytes += node.selfSize;
    pending.push(...node.children);
  }
  inspector.disconnect();
}
global.gc?.();
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    allocation: Boolean(inspector),
    drops,
    cpuUsPerRequest: (cpu.user + cpu.system) / iterations,
    sampledBytesPerRequest: sampledBytes / iterations,
    retainedBytes: process.memoryUsage().heapUsed - heapBefore,
    hostLoad,
    rss: process.memoryUsage().rss,
  }),
);
clear();
