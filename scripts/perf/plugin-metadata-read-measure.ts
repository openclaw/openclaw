/**
 * Checked metadata reuse for 44 plugins across discovery, registry, and index reads.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-metadata-read-measure.ts
 *   --iterations 2000 [--allocations] [--owner .local/plugin-cache-files-base.ts]
 * Save the baseline owner before editing; the hook preserves its import resolution.
 * Alternate base/candidate in separate processes. Setup, admission, verification,
 * and forced GC are outside measurement; allocation sampling is a separate pass.
 * Accept identical bytes/identity with lower CPU/allocation. This measures warm
 * metadata reads, not cold file admission or whole-Gateway startup latency.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const ownerUrl = new URL("../../src/plugins/plugin-cache-files.ts", import.meta.url).href;
const wasOwnerReplaced = registerPerfOwnerReplacement(ownerUrl, values.owner);
const { readPluginCacheFile } = await import("../../src/plugins/plugin-cache-files.js");
const { createPluginCache, withPluginCache } = await import("../../src/plugins/plugin-cache.js");
assert(!values.owner || wasOwnerReplaced(), "Baseline owner was not loaded");
fs.mkdirSync(".local", { recursive: true });
const fixture = fs.mkdtempSync(path.resolve(".local/plugin-metadata-read-"));
const inspector = new Session();
try {
  const requests = Array.from({ length: 44 }, (_, index) => {
    const rootDir = path.join(fixture, `plugin-${index}`);
    fs.mkdirSync(rootDir);
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({ id: `plugin-${index}`, configSchema: { type: "object" } }),
    );
    return { rootDir, relativePath: "openclaw.plugin.json", rejectHardlinks: index >= 16 };
  });
  await using cache = createPluginCache();
  const admitted = withPluginCache(cache, () => requests.map(readPluginCacheFile));
  assert(admitted.every((entry) => entry.ok));
  let checksum = 0;
  const run = (count: number) =>
    withPluginCache(cache, () => {
      for (let iteration = 0; iteration < count; iteration++) {
        for (const request of requests) {
          const entry = readPluginCacheFile(request);
          if (!entry.ok) {
            throw new Error("Previously admitted metadata became unreadable");
          }
          checksum += entry.contents.length;
        }
      }
    });
  run(100);
  global.gc();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  run(iterations);
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const sampledBytes = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0,
      )
    : undefined;
  withPluginCache(cache, () => {
    for (const [index, request] of requests.entries()) {
      const entry = readPluginCacheFile(request);
      assert.equal(entry, admitted[index]);
      assert(entry.ok);
      assert.equal(JSON.parse(entry.contents.toString()).id, `plugin-${index}`);
    }
  });
  console.log(
    JSON.stringify({
      mode: values.allocations ? "allocation" : "timing",
      owner: values.owner ?? "candidate",
      iterations,
      plugins: requests.length,
      reads: iterations * requests.length,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      wallMs,
      sampledBytes,
      checksum,
      hostLoad,
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  inspector.disconnect();
  fs.rmSync(fixture, { recursive: true, force: true });
}
