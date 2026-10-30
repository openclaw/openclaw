/**
 * Compare postings retention and ranking using bundled skill text plus 40 synthetic
 * eight-tool plugins. Save the baseline ranking module before editing, then run
 * each owner in a fresh process, counterbalancing order (at least five per side):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-search-lexical-measure.ts
 *   --owner .local/baseline-ranking.ts [--allocations]
 * --lifecycle models 64 sessions searching each minute for an hour, with catalog
 * revisions at minutes 20 and 40. --index-owner selects the matching saved index
 * module (its imports must resolve to --owner). Each modeled minute scores real
 * queries and yields through a GC boundary; this is not a wall-clock soak.
 * Keep allocation sampling separate from untraced timing/GC runs. The score digest
 * must match exactly; report retained heap, build/search CPU, natural GC and tails.
 * --views measures 2,000 new views of a 40-plugin catalog (one changing document,
 * changing visibility), then warm requests. Save the index owner beside itself
 * as .tool-search-index-baseline.ts and pass --index-owner to compare revisions.
 * Run five serial AB/BA pairs, timing and --allocations separately. Digests must
 * match. This owner workload measures rebuild cost, not its production frequency.
 * --catalogs measures 2,000 fresh run catalogs (320 tools, 64 concurrent catalogs),
 * interleaving two metadata generations and two visibility sets. Published schemas
 * stay shared while descriptors and executor closures are run-owned. It reports
 * distinct shared indexes, live/settled heap and weak-reference survival after GC;
 * this isolates search ownership, not whole-Gateway settlement or throughput.
 * Add --catalog-churn to give the first tool fresh text every run while keeping
 * the other 319 stable. Only the last four indexes stay pinned after settlement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { publishRuntimeToolInputSchema } from "../../packages/ai/src/providers/tool-schema-json-projection.js";
import type * as Ranking from "../../src/agents/tool-search-ranking.js";
import type { ToolSearchCatalogEntry } from "../../src/agents/tool-search-types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/agents/tool-search-ranking.ts" },
    allocations: { type: "boolean", default: false },
    lifecycle: { type: "boolean", default: false },
    views: { type: "boolean", default: false },
    catalogs: { type: "boolean", default: false },
    "catalog-churn": { type: "boolean", default: false },
    "index-owner": { type: "string", default: "src/agents/tool-search-index.ts" },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(!values["catalog-churn"] || values.catalogs, "--catalog-churn requires --catalogs");
const { buildLexicalIndex, scoreLexical, tokenizeDocument, tokenizeQuery } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof Ranking;
const skills = readdirSync("skills", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  .map((entry) => {
    try {
      return readFileSync(path.join("skills", entry.name, "SKILL.md"), "utf8").slice(0, 16_384);
    } catch {
      return "";
    }
  })
  .filter(Boolean);
const actions = ["search", "read", "write", "list", "create", "delete", "send", "schedule"];
const resources = [
  "calendar",
  "message",
  "repository",
  "file",
  "image",
  "weather",
  "invoice",
  "task",
];
const tools = Array.from({ length: 320 }, (_, i) => {
  const action = actions[i % actions.length]!;
  const resource = resources[Math.floor(i / actions.length) % resources.length]!;
  return `plugin_${Math.floor(i / 8)}_${action} ${action} ${resource} records. Query by identifier, name, date, status or channel. Return matching ${resource} details with pagination.`;
});
if (values.catalogs) {
  const { getToolSearchLexicalIndex } = (await import(
    pathToFileURL(path.resolve(values["index-owner"])).href
  )) as typeof import("../../src/agents/tool-search-index.js");
  const iterations = 2_000;
  const schemas = tools.map((_, position) => {
    const source = Type.Object({
      query: Type.String({ description: `Find ${resources[position % resources.length]} records` }),
      filter: Type.Object({
        status: Type.String({ description: "Filter by current record status" }),
        identifiers: Type.Array(Type.String({ description: "Exact resource identifier" })),
      }),
      page: Type.Object({
        cursor: Type.String({ description: "Continue from a previous page" }),
        limit: Type.Number({ description: "Maximum matching records" }),
      }),
    });
    return { source, published: publishRuntimeToolInputSchema(source).schema };
  });
  const current: ToolSearchCatalogEntry[][] = [];
  const weakTools: WeakRef<object>[] = [];
  const weakExecutors: WeakRef<object>[] = [];
  const indexes = new WeakSet<ReturnType<typeof getToolSearchLexicalIndex>>();
  const retainedIndexes: Array<ReturnType<typeof getToolSearchLexicalIndex>> = [];
  let distinctIndexes = 0;
  const query = tokenizeQuery("read file records");
  const digest = createHash("sha256");
  const operate = (iteration: number, measured: boolean) => {
    const generation = values["catalog-churn"]
      ? `${measured ? "run" : "warm"}-${iteration}`
      : Math.floor(iteration / 2) % 2;
    const run = { id: `synthetic-run-${iteration}` };
    const catalog: ToolSearchCatalogEntry[] = tools.map((description, position) => {
      const name = `plugin_${Math.floor(position / 8)}_${actions[position % actions.length]}`;
      const schema = schemas[position]!;
      const tool = {
        name,
        label: name,
        description: position === 0 ? `${description} Generation ${generation}` : description,
        parameters: schema.source,
        execute: async () => ({ content: [{ type: "text" as const, text: run.id }], details: {} }),
      };
      return {
        id: `openclaw:plugin_${Math.floor(position / 8)}:${name}`,
        source: "openclaw",
        sourceName: `plugin_${Math.floor(position / 8)}`,
        name,
        label: name,
        description: tool.description,
        parameters: schema.published,
        tool,
      };
    });
    // Both visibility sets retain the changing entry so each revision stays distinct.
    const visible = catalog.filter((_, position) => position % 8 !== (iteration % 2) + 1);
    const index = getToolSearchLexicalIndex(catalog, visible);
    current[iteration % 64] = catalog;
    if (measured) {
      if (!indexes.has(index)) {
        indexes.add(index);
        distinctIndexes++;
      }
      retainedIndexes[iteration % 4] = index;
      weakTools.push(new WeakRef(catalog[0]!.tool));
      weakExecutors.push(new WeakRef(catalog[0]!.tool.execute));
      digest.update(JSON.stringify(scoreLexical(index, query)));
    }
  };
  const collect = async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      await yieldTurn();
      global.gc!();
    }
    await yieldTurn();
  };
  for (let iteration = 0; iteration < 64; iteration++) {
    operate(iteration, false);
  }
  current.length = 0;
  await collect();
  const before = process.memoryUsage();
  const hostLoad = loadavg();
  const profiler = values.allocations ? new inspector.Session() : undefined;
  profiler?.connect();
  if (profiler) {
    await profiler.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const gcEvents: Array<{ kind: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcEvents.push({
        kind: (entry as import("node:perf_hooks").PerformanceNodeEntry).detail.kind,
        duration: entry.duration,
      });
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const started = performance.now();
  const cpuStart = process.threadCpuUsage();
  for (let iteration = 0; iteration < iterations; iteration++) {
    operate(iteration, true);
    if (iteration % 25 === 0) {
      await yieldTurn();
    }
  }
  const cpu = process.threadCpuUsage(cpuStart);
  const wallMs = performance.now() - started;
  await yieldTurn();
  observer.disconnect();
  let sampledBytes: number | undefined;
  if (profiler) {
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    profiler.disconnect();
  }
  await collect();
  const active = process.memoryUsage();
  const activeCatalogs = current.length;
  current.length = 0;
  await collect();
  const settled = process.memoryUsage();
  console.log(
    JSON.stringify({
      owner: values["index-owner"],
      iterations,
      tools: tools.length,
      activeCatalogs,
      churn: values["catalog-churn"],
      distinctIndexes,
      retainedIndexes: retainedIndexes.length,
      hostLoad,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      sampledBytes,
      digest: digest.digest("hex"),
      gcEvents,
      activeRetainedHeapBytes: active.heapUsed - before.heapUsed,
      settledRetainedHeapBytes: settled.heapUsed - before.heapUsed,
      sampledRunWrappers: weakTools.length,
      survivingTools: weakTools.filter((reference) => reference.deref()).length,
      survivingExecutors: weakExecutors.filter((reference) => reference.deref()).length,
      active,
      settled,
    }),
  );
  process.exit(0);
}
if (values.views) {
  const { getTextLexicalIndex } = (await import(
    pathToFileURL(path.resolve(values["index-owner"])).href
  )) as typeof import("../../src/agents/tool-search-index.js");
  const iterations = 2_000;
  const query = tokenizeQuery("read file records");
  const digest = createHash("sha256");
  const profiler = values.allocations ? new inspector.Session() : undefined;
  const gcEvents: Array<{ kind: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcEvents.push({
        kind: (entry as import("node:perf_hooks").PerformanceNodeEntry).detail.kind,
        duration: entry.duration,
      });
    }
  });
  const prepare = (revision: number) =>
    getTextLexicalIndex([
      ...tools.filter((_, position) => position % 8 !== revision % 8),
      `Current catalog revision ${revision}`,
    ]);
  // Warm compilation separately from the measured unique revisions.
  for (let iteration = 0; iteration < 50; iteration++) {
    prepare(-iteration - 1);
  }
  await yieldTurn();
  global.gc();
  await yieldTurn();
  const before = process.memoryUsage();
  const hostLoad = loadavg();
  profiler?.connect();
  if (profiler) {
    await profiler.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const started = performance.now();
  const cpuStart = process.threadCpuUsage();
  for (let iteration = 0; iteration < iterations; iteration++) {
    digest.update(JSON.stringify(scoreLexical(prepare(iteration), query)));
    if (iteration % 25 === 0) {
      await yieldTurn();
    }
  }
  const cpu = process.threadCpuUsage(cpuStart);
  const wallMs = performance.now() - started;
  await yieldTurn();
  observer.disconnect();
  let sampledBytes: number | undefined;
  if (profiler) {
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    profiler.disconnect();
  }
  const warmCpuStart = process.threadCpuUsage();
  for (let iteration = 0; iteration < iterations; iteration++) {
    prepare(iterations - 1);
  }
  const warmCpu = process.threadCpuUsage(warmCpuStart);
  // Let WeakRef keep-alives and finalizers retire before reporting retained heap.
  for (let cycle = 0; cycle < 2; cycle++) {
    await yieldTurn();
    global.gc();
  }
  await yieldTurn();
  console.log(
    JSON.stringify({
      owner: values["index-owner"],
      iterations,
      tools: tools.length,
      hostLoad,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      warmCpuMs: (warmCpu.user + warmCpu.system) / 1000,
      sampledBytes,
      digest: digest.digest("hex"),
      gcEvents,
      retainedHeapBytes: process.memoryUsage().heapUsed - before.heapUsed,
      ...process.memoryUsage(),
    }),
  );
  process.exit(0);
}
const documents = [...skills, ...tools].map((text, value) => ({
  value,
  terms: tokenizeDocument(text),
}));
if (values.lifecycle) {
  const { getTextLexicalIndex } = (await import(
    pathToFileURL(path.resolve(values["index-owner"])).href
  )) as typeof import("../../src/agents/tool-search-index.js");
  const observed = new WeakSet<ReturnType<typeof getTextLexicalIndex>>();
  const current = Array<ReturnType<typeof getTextLexicalIndex>>(64);
  const query = tokenizeQuery("read file content");
  let distinctIndexes = 0;
  let searches = 0;
  for (let minute = 0; minute < 60; minute++) {
    for (let session = 0; session < 64; session++) {
      // Fresh arrays represent separate runs with the same admitted text.
      const revision = Math.floor(minute / 20);
      const index = getTextLexicalIndex([...skills, ...tools, `Catalog revision ${revision}`]);
      if (!observed.has(index)) {
        observed.add(index);
        distinctIndexes++;
      }
      current[session] = index;
      assert(scoreLexical(index, query).length > 0);
      searches++;
    }
    await yieldTurn();
    global.gc();
  }
  assert.equal(distinctIndexes, 3);
  assert(current.every((index) => index === current[0]));
  console.log(
    JSON.stringify({
      modeledMinutes: 60,
      sessions: 64,
      searches,
      distinctIndexes,
      gcBoundaries: 60,
    }),
  );
  process.exit(0);
}
const queries = [
  "",
  "the and",
  "calendar event",
  "look up the price",
  "repository issue",
  "send message",
  "reminder tomorrow",
  "read file",
  "running commands",
  "cookies policies",
  "価格",
  "no_such_capability",
].map(tokenizeQuery);
const retained = [];
const gcEvents: Array<{ kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcEvents.push({
      kind: (entry as import("node:perf_hooks").PerformanceNodeEntry).detail.kind,
      duration: entry.duration,
    });
  }
});
const profiler = values.allocations ? new inspector.Session() : undefined;
for (let i = 0; i < 5; i++) {
  scoreLexical(buildLexicalIndex(documents), queries[2]!);
}
global.gc();
await yieldTurn();
const before = process.memoryUsage();
for (let i = 0; i < 16; i++) {
  retained.push(buildLexicalIndex(documents));
}
global.gc();
await yieldTurn();
const after = process.memoryUsage();
const index = retained[0]!;
const digest = createHash("sha256")
  .update(JSON.stringify(queries.map((query) => scoreLexical(index, query))))
  .digest("hex");
profiler?.connect();
if (profiler) {
  await profiler.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
observer.observe({ entryTypes: ["gc"] });
const start = performance.now();
const buildCpuStart = process.threadCpuUsage();
for (let i = 0; i < 100; i++) {
  retained[i % retained.length] = buildLexicalIndex(documents);
  if (i % 10 === 0) {
    await yieldTurn();
  }
}
const buildCpu = process.threadCpuUsage(buildCpuStart);
const buildMs = performance.now() - start;
await yieldTurn();
observer.disconnect();
const buildGc = gcEvents.splice(0);
// Discard build garbage before timing searches; collector carryover is not query work.
global.gc();
await yieldTurn();
observer.observe({ entryTypes: ["gc"] });
const searchCpuStart = process.threadCpuUsage();
const timings: number[] = [];
let hits = 0;
for (let i = 0; i < 12_000; i++) {
  const at = performance.now();
  hits += scoreLexical(index, queries[i % queries.length]!).length;
  timings.push(performance.now() - at);
  if (i % 100 === 0) {
    await yieldTurn();
  }
}
const searchCpu = process.threadCpuUsage(searchCpuStart);
await yieldTurn();
observer.disconnect();
let allocatedBytes: number | undefined;
if (profiler) {
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  profiler.disconnect();
}
timings.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    owner: values.owner,
    sampled: values.allocations,
    documents: documents.length,
    skillBodies: skills.length,
    terms: documents.reduce((n, doc) => n + doc.terms.length, 0),
    retainedIndexes: retained.length,
    retainedHeapBytes: after.heapUsed - before.heapUsed,
    retainedExternalBytes: after.external - before.external,
    digest,
    hits,
    builds: 100,
    buildMs,
    buildCpu,
    searches: timings.length,
    searchCpu,
    searchP50Ms: timings[5999],
    searchP99Ms: timings[11879],
    elapsedMs: performance.now() - start,
    allocatedBytes,
    buildGc,
    searchGc: gcEvents,
  }),
);
