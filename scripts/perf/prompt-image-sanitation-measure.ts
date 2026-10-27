/**
 * Warm history-image sanitation: real owner, synthetic PNGs, no Gateway or provider.
 * Run from the checkout: node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/prompt-image-sanitation-measure.ts cpu [owner-path]
 * Repeat with allocation for a separate 4 KiB allocation sampling pass (including
 * collected objects). Optional owner-path is a pristine baseline module beside
 * tool-images.ts so its relative imports resolve against the same dependencies.
 * Compare five alternating base/candidate runs per mode. Each run prepares twelve
 * distinct 96x96 PNGs, warms 50 turns, then sanitizes 2,000 turns. Canonical and
 * whitespace-bearing history are separate cases. Output bytes are checked before
 * timing. Accept reduced CPU/allocation with identical outputs and changed-input
 * regression proof; report host load and absolute GC deltas, not tiny percentages.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";

const mode = process.argv[2];
assert(mode === "cpu" || mode === "allocation", "mode must be cpu or allocation");
assert(globalThis.gc, "--expose-gc required");
const owner = resolve(process.argv[3] ?? "src/agents/tool-images.ts");
const { sanitizeContentBlocksImages } = (await import(
  pathToFileURL(owner).href
)) as typeof import("../../src/agents/tool-images.js");
const iterations = 2_000;
const images = Array.from({ length: 12 }, (_, index) => ({
  type: "image" as const,
  data: createNoisyPngBuffer(96, 96 + index).toString("base64"),
  mimeType: "image/png",
}));
const inspector = new Session();
inspector.connect();
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
for (const dialect of ["canonical", "whitespace"] as const) {
  const blocks = images.map((image) =>
    Object.freeze({
      ...image,
      data:
        dialect === "canonical"
          ? image.data
          : `${image.data.slice(0, 128)}\n${image.data.slice(128)}`,
    }),
  );
  const turn = () =>
    sanitizeContentBlocksImages(blocks, "bench:history", { verifyDecodability: true });
  assert.deepEqual(await turn(), images);
  for (let i = 0; i < 50; i++) {
    await turn();
  }
  globalThis.gc();
  await setImmediate();
  let gcMs = 0;
  let gcCount = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcMs += entry.duration;
      gcCount++;
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  if (mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    await turn();
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const sampledBytes =
    mode === "allocation"
      ? allocated((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  console.log(
    JSON.stringify({
      owner,
      mode,
      dialect,
      iterations,
      images: images.length,
      base64BytesPerTurn: images.reduce((sum, image) => sum + image.data.length, 0),
      cpuUsPerTurn: (cpu.user + cpu.system) / iterations,
      elapsedMs,
      sampledBytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gcMs,
      gcCount,
      load: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
}
inspector.disconnect();
