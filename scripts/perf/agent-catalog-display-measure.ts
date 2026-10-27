/**
 * Prepared agent-display catalog CPU and allocation with 1,000 models and 40 plugins.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-catalog-display-measure.ts
 * Add --owner /absolute/base-view.ts to load a saved original owner through the same
 * import graph. Alternate base/candidate order; --iterations defaults to 3000.
 * Add --allocations for a separate sampled-allocation pass, including collected objects.
 * Fixtures/imports/warmup are excluded. Display identities must stay identical; compare
 * CPU/allocation per view with host load. Real Gateway RPC proof covers transport/latency.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 3000,
  min: 1,
  label: "iterations",
});
const ownerUrl = new URL("../../src/gateway/server-model-catalog-view.ts", import.meta.url).href;
let replaced = false;
if (values.owner) {
  const replacement = pathToFileURL(path.resolve(values.owner)).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl) {
        return nextLoad(url, context);
      }
      replaced = true;
      const result = nextLoad(replacement, context);
      return { format: result.format, source: result.source, shortCircuit: true };
    },
  });
}
const { createPreparedGatewayModelCatalog, readPreparedGatewayModelCatalogMetadata } =
  await import("../../src/gateway/server-model-catalog-view.js");
assert(!values.owner || replaced, "Requested baseline owner was not loaded");
const plugins = Array.from({ length: 40 }, (_, index) => ({
  id: `synthetic-${index}`,
  providers: [`provider-${index}`],
}));
const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins });
const pluginRegistry = createEmptyPluginRegistry();
pluginRegistry.providers = plugins.map((plugin, index) => ({
  pluginId: plugin.id,
  source: `/synthetic/${plugin.id}/index.ts`,
  provider: { id: `provider-${index}`, label: `Provider ${index}`, auth: [] },
}));
const entries = Array.from({ length: 1000 }, (_, index) => ({
  id: `model-${index}`,
  provider: `provider-${index % 40}`,
  name: `Model ${index}`,
  contextTokens: 128_000,
  reasoning: true,
}));
const input = { entries, pluginRegistry, metadataSnapshot, includeSessionRowPolicy: false };
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const view = createPreparedGatewayModelCatalog(input);
    assert.equal(view.entries, entries);
    assert.equal(view.pluginRegistry, pluginRegistry);
    assert.equal(readPreparedGatewayModelCatalogMetadata(view), metadataSnapshot);
  }
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
run(1000);
globalThis.gc?.();
const inspector = new Session();
try {
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  run(iterations);
  const wallMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const allocatedBytes = values.allocations
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  console.log(
    JSON.stringify({
      mode: values.allocations ? "allocation" : "timing",
      owner: values.owner ?? ownerUrl,
      node: process.version,
      models: entries.length,
      plugins: plugins.length,
      iterations,
      cpuMs: (used.user + used.system) / 1000,
      wallMs,
      allocatedBytes,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  inspector.disconnect();
}
