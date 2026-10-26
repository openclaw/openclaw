/**
 * Synthetic 16-row native page with 64 KiB previews (~1 MiB wire JSON/page).
 * Run on each revision, alternating base/candidate; fixtures and warmup are excluded.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-catalog-page-decode.ts
 * --sample measures allocations separately from untraced CPU; --projection excludes JSON decode.
 * Defaults to 2,000 pages (32,000 previews) per sample. Outputs one JSON record.
 * Compare resultSha256 across revisions to verify byte-identical projected results.
 * --owner /path/to/client-catalog-response.ts selects a preserved owner revision.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    sample: { type: "boolean", default: false },
    projection: { type: "boolean", default: false },
    owner: { type: "string" },
  },
});
const ownerUrl = values.owner
  ? pathToFileURL(values.owner)
  : new URL("../../extensions/codex/src/app-server/client-catalog-response.ts", import.meta.url);
const {
  decodeCodexCatalogFrame,
  projectCodexCatalogMessage,
}: typeof import("../../extensions/codex/src/app-server/client-catalog-response.js") = await import(
  ownerUrl.href
);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const id = Number.MAX_SAFE_INTEGER - 2;
const data = Array.from({ length: 16 }, (_, index) => ({
  id: `synthetic-thread-${index}`,
  preview: `Synthetic preview ${index} `.padEnd(64 * 1024, "x"),
  cwd: "/synthetic/workspace",
  source: "cli",
  updatedAt: 1000 + index,
}));
const result = { data, nextCursor: "synthetic-next" };
const bytes = Buffer.from(JSON.stringify({ id, result }));
const input = { bytes, route: { id, kind: "list" as const } };
const run = values.projection
  ? () => projectCodexCatalogMessage({ id, result }, input)
  : () => decodeCodexCatalogFrame(input);
const expected = JSON.stringify(run());
for (let index = 0; index < 100; index++) {
  run();
}
global.gc?.();
const inspector = new Session();
if (values.sample) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const start = performance.now();
const cpu = process.cpuUsage();
let last;
for (let index = 0; index < iterations; index++) {
  last = run();
}
const used = process.cpuUsage(cpu);
const elapsedMs = performance.now() - start;
let allocatedBytes: number | undefined;
if (values.sample) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
assert.equal(JSON.stringify(last), expected);
console.log(
  JSON.stringify({
    mode: values.projection ? "projection" : "frame",
    sample: values.sample,
    iterations,
    pageBytes: bytes.length,
    resultSha256: createHash("sha256").update(expected).digest("hex"),
    hostLoad,
    elapsedMs,
    cpuUsPerPage: (used.user + used.system) / iterations,
    allocatedBytesPerPage: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    rss: process.memoryUsage().rss,
    heapUsed: process.memoryUsage().heapUsed,
  }),
);
