// Serialize actual synthetic requests captured by prompt-cache-drops-measure.ts
// --capture .local/requests.json. Compare base/candidate inputs, alternating five
// times. CPU is untraced; allocation is a separate --allocation pass.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/prompt-cache-request-cost.ts
//   --input .local/requests.json --iterations 3000 [--allocation]
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { prepareProviderPrompt } from "../../src/agents/embedded-agent-runner/provider-prompt-serialization.js";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean" },
  },
});
assert.ok(values.input);
const requests: unknown = JSON.parse(await readFile(values.input, "utf8"));
assert.ok(Array.isArray(requests) && requests.length > 0);
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
for (let i = 0; i < 100; i++) {
  prepareProviderPrompt({ payload: requests[i % requests.length], encode: true });
}
global.gc?.();
const inspector = values.allocation ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const started = process.cpuUsage();
let bytes = 0;
for (let i = 0; i < iterations; i++) {
  bytes += prepareProviderPrompt({
    payload: requests[i % requests.length],
    encode: true,
  }).byteWeight;
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
console.log(
  JSON.stringify({
    iterations,
    allocation: Boolean(inspector),
    cpuUsPerRequest: (cpu.user + cpu.system) / iterations,
    sampledBytesPerRequest: sampledBytes / iterations,
    wireBytesPerRequest: bytes / iterations,
    hostLoad: loadavg(),
  }),
);
