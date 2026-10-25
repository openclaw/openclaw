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
 * This owner workload supplements, never replaces, the loaded Gateway comparison.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import inspector from "node:inspector/promises";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type * as Ranking from "../../src/agents/tool-search-ranking.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/agents/tool-search-ranking.ts" },
    allocations: { type: "boolean", default: false },
    lifecycle: { type: "boolean", default: false },
    "index-owner": { type: "string", default: "src/agents/tool-search-index.ts" },
  },
});
assert(global.gc, "Run with --expose-gc");
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
