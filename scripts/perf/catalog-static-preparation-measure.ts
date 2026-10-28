/**
 * Static catalog preparation with 40 provider hooks and 10,000 retained model rows.
 * node --import ./scripts/tsx.mjs scripts/perf/catalog-static-preparation-measure.ts \
 *   --iterations 3000 --mode timing [--owner /absolute/provider-discovery.ts]
 * Alternate baseline/candidate runs. Allocation sampling is a separate diagnostic pass;
 * this measures the preparation owner, not Gateway throughput or retained worker heap.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { ModelProviderConfig } from "../../src/config/types.models.js";
import type { ProviderPlugin } from "../../src/plugins/types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
const owner = new URL("../../src/plugins/provider-discovery.ts", import.meta.url);
{
  const source = stripTypeScriptTypes(
    readFileSync(values.owner ? pathToFileURL(values.owner) : owner, "utf8"),
  );
  registerHooks({
    load(url, context, nextLoad) {
      return url === owner.href
        ? { format: "module", source, shortCircuit: true }
        : nextLoad(url, context);
    },
  });
}
const { prepareProviderStaticCatalog }: typeof import("../../src/plugins/provider-discovery.js") =
  await import(owner.href);
let calls = 0;
const providers: ProviderPlugin[] = Array.from({ length: 40 }, (_provider, providerIndex) => {
  const id = `synthetic-${providerIndex}`;
  const config: ModelProviderConfig = {
    api: "openai-completions",
    baseUrl: "https://catalog.invalid/v1",
    models: Array.from({ length: 250 }, (_model, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  };
  return {
    id,
    label: id,
    auth: [],
    staticCatalog: {
      async run() {
        calls++;
        return { provider: config };
      },
    },
  };
});
for (let index = 0; index < 200; index++) {
  await prepareProviderStaticCatalog({ providers });
}
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.collectGarbage");
if (values.mode === "allocation") {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const profiler = new GCProfiler();
profiler.start();
calls = 0;
const started = performance.now();
const cpu = process.threadCpuUsage();
let prepared;
for (let index = 0; index < iterations; index++) {
  prepared = await prepareProviderStaticCatalog({ providers });
}
const elapsedMs = performance.now() - started;
const cpuUsed = process.threadCpuUsage(cpu);
const gc = profiler.stop();
const allocation =
  values.mode === "allocation"
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
inspector.disconnect();
assert.equal(calls, iterations * providers.length);
assert(prepared);
assert.equal(prepared.entries.length, 40);
assert.equal(prepared.entries[0]?.provider.id, "synthetic-0");
assert.equal(prepared.entries[0]?.providerConfigs["synthetic-0"]?.models.length, 250);
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + sampledBytes(child), 0);
}
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    providers: providers.length,
    modelRows: 10000,
    calls,
    elapsedMs,
    cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    sampledBytes: allocation ? sampledBytes(allocation.head) : undefined,
    gcMs: gc?.statistics.reduce((total, sample) => total + sample.cost / 1000, 0),
  }),
);
