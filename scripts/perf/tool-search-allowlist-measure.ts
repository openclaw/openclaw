/**
 * Measure warm catalog reuse for 40 synthetic plugins with eight tools each.
 * Before editing, save src/agents/tool-search-catalog.ts beside itself as
 * .tool-search-catalog-baseline.ts, then run both owners in AB/BA order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-search-allowlist-measure.ts
 *   --owner src/agents/.tool-search-catalog-baseline.ts [--allocations]
 * Omit --owner for the candidate. Remove the saved baseline after measurement.
 * Timing and sampled allocation use separate processes; --iterations defaults
 * to 3000. This measures catalog preparation, not whole-Gateway performance.
 */
import assert from "node:assert/strict";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { setPluginToolMeta } from "../../src/plugins/tool-metadata.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/agents/tool-search-catalog.ts" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const { applyToolCatalogCompaction, createToolSearchCatalogRef } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof import("../../src/agents/tool-search-catalog.js");
const parameters = Type.Object({});
const tools: AnyAgentTool[] = Array.from({ length: 320 }, (_, index) => {
  const name = `plugin_${Math.floor(index / 8)}_tool_${index % 8}`;
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: "Read a synthetic record",
    parameters,
    execute: async () => ({ content: [], details: {} }),
  };
  setPluginToolMeta(tool, { pluginId: `plugin_${Math.floor(index / 8)}`, optional: true });
  return tool;
});
const allowlists = [tools.map((tool) => tool.name), tools.map((tool) => tool.name)];
tools.unshift({
  name: "tool_search",
  label: "Tool Search",
  description: "Find tools",
  parameters,
  execute: async () => ({ content: [], details: {} }),
});
const catalogRef = createToolSearchCatalogRef();
const prepare = (index: number) =>
  applyToolCatalogCompaction({
    tools,
    enabled: true,
    catalogRef,
    toolExecutionAllow: allowlists[index % 2],
    isVisibleControlTool: (tool) => tool.name === "tool_search",
  });
prepare(0);
for (let index = 0; index < 100; index++) {
  assert(prepare(index).catalogReused);
}
global.gc?.();
const session = new inspector.Session();
if (values.allocations) {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  assert(prepare(index).catalogReused);
}
const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
let sampledBytes: number | undefined;
if (values.allocations) {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  session.disconnect();
}
console.log(
  JSON.stringify({
    owner: values.owner,
    iterations,
    hostLoad,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    ...process.memoryUsage(),
  }),
);
