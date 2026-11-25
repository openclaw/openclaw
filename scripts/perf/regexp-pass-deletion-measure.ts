/**
 * Owner microbench for redundant regex passes over 10k synthetic row labels.
 * node --import ./scripts/tsx.mjs scripts/perf/regexp-pass-deletion-measure.ts
 * --module-root <directory> selects source owners with their dependencies intact.
 * Alternate base/candidate runs; add --allocations for a separate 4096-byte
 * sampled-allocation pass (ignore its timings). Five batches of 2,000 operations
 * follow warmup. Acceptance: identical results with less CPU/allocation; report
 * host load and every batch. This makes no whole-Gateway latency claim.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { WikiPageSummary } from "../../extensions/memory-wiki/src/markdown.js";

const { values } = parseArgs({
  options: {
    "module-root": { type: "string", default: process.cwd() },
    allocations: { type: "boolean", default: false },
  },
});
const moduleUrl = (name: string) => pathToFileURL(resolve(values["module-root"], name)).href;
const { matchRealtimeVoiceConsultQuestions }: typeof import("../../src/talk/consult-question.js") =
  await import(moduleUrl("src/talk/consult-question.ts"));
const { slugifyWikiSegment }: typeof import("../../extensions/memory-wiki/src/markdown.js") =
  await import(moduleUrl("extensions/memory-wiki/src/markdown.ts"));
const {
  buildPageContradictionClusters,
}: typeof import("../../extensions/memory-wiki/src/claim-health.js") = await import(
  moduleUrl("extensions/memory-wiki/src/claim-health.ts")
);
const { slugify }: typeof import("../../extensions/oc-path/src/oc-path/slug.js") = await import(
  moduleUrl("extensions/oc-path/src/oc-path/slug.ts")
);

const words = [
  ["ALPHA", "alpha", "alpha"],
  ["CAFÉ", "café", "caf"],
  ["किताब", "किताब", ""],
  ["e\u0301", "e\u0301", "e"],
  ["東京", "東京", ""],
] as const;
const rows = Array.from({ length: 10_000 }, (_, index) => {
  const [word, lower, ascii] = words[index % words.length]!;
  const input = `  ${word}___ --\t item_${index}!!\u00a0  `;
  const page: WikiPageSummary = {
    absolutePath: `/synthetic/entities/${index}.md`,
    relativePath: `entities/${index}.md`,
    kind: "entity",
    title: word,
    hasFrontmatter: true,
    aliases: [],
    sourceIds: [],
    linkTargets: [],
    claims: [],
    contradictions: [input],
    questions: [],
    relationships: [],
    bestUsedFor: [],
    notEnoughFor: [],
    bridgeAgentIds: [],
  };
  const row = {
    input,
    pages: [page],
    question: `${word} item ${index}`,
    wiki: `${lower}-item-${index}`,
    ocPath: `${ascii ? `${ascii}-` : ""}item-${index}`,
    cluster: `${lower} item ${index} `,
  };
  assert.equal(slugifyWikiSegment(input), row.wiki);
  assert.equal(slugify(input), row.ocPath);
  assert.equal(buildPageContradictionClusters(row.pages)[0]?.key, row.cluster);
  assert.equal(matchRealtimeVoiceConsultQuestions(input, row.question), true);
  return row;
});
type Row = (typeof rows)[number];
const workloads: Array<{ name: string; run: (row: Row) => number; expected: number }> = [
  {
    name: "voice-question",
    run: (row) => Number(matchRealtimeVoiceConsultQuestions(row.input, row.question)),
    expected: rows.length,
  },
  {
    name: "wiki-slug",
    run: (row) => slugifyWikiSegment(row.input).length,
    expected: rows.reduce((sum, row) => sum + row.wiki.length, 0),
  },
  {
    name: "wiki-contradiction",
    run: (row) => buildPageContradictionClusters(row.pages)[0]!.key.length,
    expected: rows.reduce((sum, row) => sum + row.cluster.length, 0),
  },
  {
    name: "oc-path-slug",
    run: (row) => slugify(row.input).length,
    expected: rows.reduce((sum, row) => sum + row.ocPath.length, 0),
  },
];
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
}
try {
  for (const workload of workloads) {
    for (const row of rows) {
      workload.run(row);
    }
    const loadBefore = loadavg();
    if (values.allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    let checksum = 0;
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const started = performance.now();
      const cpu = process.threadCpuUsage();
      for (let index = 0; index < 2000; index++) {
        checksum += workload.run(rows[sample * 2000 + index]!);
      }
      const used = process.threadCpuUsage(cpu);
      samples.push({
        elapsedMs: performance.now() - started,
        cpuMs: (used.user + used.system) / 1000,
      });
    }
    let sampledBytes: number | undefined;
    if (values.allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const nodes = [profile.head];
      sampledBytes = 0;
      for (const node of nodes) {
        sampledBytes += node.selfSize;
        nodes.push(...node.children);
      }
    }
    assert.equal(checksum, workload.expected);
    console.log(
      JSON.stringify({
        workload: workload.name,
        operations: rows.length,
        checksum,
        sampledBytes,
        samples,
        loadBefore,
        loadAfter: loadavg(),
      }),
    );
  }
} finally {
  if (values.allocations) {
    inspector.disconnect();
  }
}
