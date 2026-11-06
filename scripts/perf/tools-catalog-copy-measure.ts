/**
 * Synthetic tools.catalog owner microbenchmark: 40 plugins x 25 tools, no real
 * config, registry, credentials, transport, or Gateway latency measurement.
 * node --import ./scripts/tsx.mjs scripts/perf/tools-catalog-copy-measure.ts \
 *   --owner-file .local/base-tools-catalog.ts --iterations 3000 --mode timing
 * Omit --owner-file for the current source. Alternate base/candidate timing runs;
 * run allocation and counts separately because instrumentation changes timing.
 * --mode counts --expect-copies 0 proves removal; the baseline copies 41 arrays.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { ToolsCatalogResult } from "../../packages/gateway-protocol/src/index.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    "expect-copies": { type: "string" },
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "iterations must be positive");
assert(["timing", "allocation", "counts"].includes(values.mode), "invalid mode");
const expectedCopies =
  values["expect-copies"] === undefined ? undefined : Number(values["expect-copies"]);
assert(
  expectedCopies === undefined ||
    (values.mode === "counts" && Number.isSafeInteger(expectedCopies) && expectedCopies >= 0),
  "expect-copies requires counts mode and a nonnegative integer",
);
const ownerUrl = new URL("../../src/gateway/server-methods/tools-catalog.ts", import.meta.url);
const ownerSource = readFileSync(values["owner-file"] ?? ownerUrl, "utf8");
// Every owner import is a synthetic boundary; no runtime dependency tree loads.
const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
export const sourceTools = Object.freeze(Array.from({length: 1000}, (_, i) => Object.freeze({
  name: 'tool_' + String(999-i).padStart(4, '0'),
  pluginId: 'plugin_' + String(39-Math.floor(i/25)).padStart(2, '0'),
  description: 'Synthetic tool description', parameters: Object.freeze({type: 'object'})
})));
const registry = Object.freeze({tools: Object.freeze([]), toolMetadata: Object.freeze([])});
export const resolvePluginTools = () => sourceTools;
export const getPluginToolMeta = tool => ({pluginId: tool.pluginId});
export const ensureStandalonePluginToolRegistryLoaded = () => registry;
export const getActivePluginRegistry = () => registry;
const acquisition = Object.freeze({registry, resolveTools: () => sourceTools, release: async () => {}});
export const acquireStandalonePluginToolRegistry = async () => acquisition;
export const retainRuntimePluginWork = () => () => {};
export const capturePluginLifecycleAuthority = () => () => true;
export const getPluginRuntimeGatewayRequestScope = () => undefined;
export const getPluginRuntimeLoadContext = () => undefined;
export const createPluginToolMetadataLookup = () => () => undefined;
export const resolveAgentIdOrRespondError = () => ({cfg: {}, agentId: 'synthetic'});
export const resolveAgentDir = () => '/synthetic/agent';
export const resolveAgentWorkspaceDir = () => '/synthetic/workspace';
export const resolveSwarmConfig = () => ({enabled: false});
export const listCoreToolSections = () => [];
export const resolveCoreToolProfiles = () => [];
export const PROFILE_OPTIONS = [];
export const hasMultipleResidentSessionSharingIdentities = () => false;
export const assertValidParams = () => true;
export const validateToolsCatalogParams = () => true;
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const normalizeOptionalString = value => typeof value === 'string' ? value.trim() || undefined : undefined;
export const summarizeToolDescriptionText = ({rawDescription}) => rawDescription;
`)}`;
let loaded = false;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL === ownerUrl.href
      ? { url: fixtureUrl, shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    if (url !== ownerUrl.href) {
      return next(url, context);
    }
    loaded = true;
    return { format: "module", source: stripTypeScriptTypes(ownerSource), shortCircuit: true };
  },
});
type CatalogOwner = {
  toolsCatalogHandlers: {
    "tools.catalog": (request: {
      params: object;
      context: { getRuntimeConfig: () => object };
      respond: (ok: boolean, value: ToolsCatalogResult) => void;
    }) => void | Promise<void>;
  };
};
const owner: CatalogOwner = await import(ownerUrl.href);
const fixture: { sourceTools: readonly object[] } = await import(fixtureUrl);
hooks.deregister();
assert(loaded, "selected owner was not loaded");
const sourceBefore = JSON.stringify(fixture.sourceTools);
let output: ToolsCatalogResult | undefined;
const request = {
  params: {},
  context: { getRuntimeConfig: () => ({}) },
  respond(ok: boolean, value: ToolsCatalogResult) {
    assert(ok);
    output = value;
  },
};
const run = async (count: number) => {
  for (let i = 0; i < count; i++) {
    await owner.toolsCatalogHandlers["tools.catalog"](request);
  }
};
await run(100);
let copies = 0;
let copiedElements = 0;
const originalSort = Array.prototype.toSorted;
const inspector = new Session();
let allocatedBytes: number | undefined;
const cpuUsage = (previous?: NodeJS.CpuUsage) =>
  typeof process.threadCpuUsage === "function"
    ? process.threadCpuUsage(previous)
    : process.cpuUsage(previous);
const cpuScope = typeof process.threadCpuUsage === "function" ? "main-thread" : "process";
if (values.mode === "allocation") {
  await startCollectedHeapSampling(inspector, 32768);
}
try {
  if (values.mode === "counts") {
    // oxlint-disable-next-line no-extend-native -- Count copies only in this instrumented pass; restore in finally.
    Array.prototype.toSorted = function <T>(this: T[], compare?: (a: T, b: T) => number): T[] {
      copies++;
      copiedElements += this.length;
      return originalSort.call(this, compare);
    };
  }
  const cpu = cpuUsage();
  const started = performance.now();
  await run(iterations);
  const wallMs = performance.now() - started;
  const used = cpuUsage(cpu);
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
  }
  assert(output);
  assert.equal(output.groups.length, 40);
  for (const [groupIndex, group] of output.groups.entries()) {
    assert.equal(group.id, `plugin:plugin_${String(groupIndex).padStart(2, "0")}`);
    assert.equal(group.tools.length, 25);
    for (const [toolIndex, tool] of group.tools.entries()) {
      assert.equal(tool.id, `tool_${String(groupIndex * 25 + toolIndex).padStart(4, "0")}`);
    }
  }
  assert.equal(JSON.stringify(fixture.sourceTools), sourceBefore);
  if (expectedCopies !== undefined) {
    assert.equal(copies / iterations, expectedCopies, "array copies per handler call");
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      iterations,
      plugins: 40,
      toolsPerPlugin: 25,
      ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
      wallMs,
      cpuScope,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      ...(values.mode === "counts"
        ? { copiesPerCall: copies / iterations, copiedElementsPerCall: copiedElements / iterations }
        : {}),
      hostLoad: loadavg(),
    }),
  );
} finally {
  // oxlint-disable-next-line no-extend-native -- Restore the native method after copy-count instrumentation.
  Array.prototype.toSorted = originalSort;
  inspector.disconnect();
}
