/**
 * Real Codex line framer with synthetic 16-row catalog frames and 1 KiB chunks.
 * node --import ./scripts/tsx.mjs scripts/perf/codex-catalog-lines.ts
 * --owner /absolute/preserved/client-message-frames.ts selects a baseline owner.
 * --sample measures allocation separately from untraced CPU and natural GC.
 * --decode includes the required UTF-8 conversion and JSON parse; default is framing only.
 * This isolates line assembly/decoding; it does not measure worker projection or Gateway RPC.
 * Alternate base/candidate for five pairs. Fixture generation and warmup are excluded.
 * Acceptance: identical delivered bytes/count, lower allocation, no material CPU regression.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "5000" },
    sample: { type: "boolean", default: false },
    decode: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const ownerUrl = new URL(
  "../../extensions/codex/src/app-server/client-message-frames.ts",
  import.meta.url,
);
const selectedOwnerUrl = values.owner ? pathToFileURL(values.owner) : ownerUrl;
const ownerSha256 = createHash("sha256").update(readFileSync(selectedOwnerUrl)).digest("hex");
let baselineLoaded = !values.owner;
if (values.owner) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl.href) {
        return nextLoad(url, context);
      }
      const loaded = nextLoad(selectedOwnerUrl.href, context);
      baselineLoaded = true;
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const {
  listenCodexAppServerLines,
}: typeof import("../../extensions/codex/src/app-server/client-message-frames.js") = await import(
  ownerUrl.href
);
assert(baselineLoaded, "Requested baseline must replace the canonical line-framing owner");
const frame = Buffer.from(
  JSON.stringify({
    id: Number.MAX_SAFE_INTEGER - 2,
    result: {
      data: Array.from({ length: 16 }, (_, index) => ({
        id: `synthetic-thread-${index}`,
        preview: `Synthetic preview ${index} `.padEnd(512, "x"),
        cwd: "/synthetic/workspace",
        source: "cli",
        updatedAt: 1000 + index,
      })),
      nextCursor: "synthetic-next",
    },
  }),
);
const wire = Buffer.concat([frame, Buffer.from("\n")]);
const chunks: Buffer[] = [];
for (let offset = 0; offset < wire.length; offset += 1024) {
  chunks.push(wire.subarray(offset, offset + 1024));
}
const input = new PassThrough();
let delivered = 0;
let deliveredBytes = 0;
let last: Buffer | undefined;
let parsed: unknown;
const close = listenCodexAppServerLines(
  input,
  (line) => {
    delivered++;
    deliveredBytes += line.length;
    last = line;
    if (values.decode) {
      parsed = JSON.parse(line.toString("utf8"));
    }
  },
  (error) => {
    throw error;
  },
);
function run() {
  for (const chunk of chunks) {
    input.write(chunk);
  }
}
for (let index = 0; index < 500; index++) {
  run();
}
await setImmediate();
delivered = 0;
deliveredBytes = 0;
const collections: number[] = [];
let start = Infinity;
let end = Infinity;
const collect = (entries: PerformanceEntry[]) => {
  for (const entry of entries) {
    if (entry.startTime >= start && entry.startTime < end) {
      collections.push(entry.duration);
    }
  }
};
const observer = new PerformanceObserver((list) => collect(list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
if (values.sample) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpu = process.threadCpuUsage();
start = performance.now();
for (let index = 0; index < iterations; index++) {
  run();
}
end = performance.now();
const used = process.threadCpuUsage(cpu);
let allocatedBytes: number | undefined;
if (values.sample) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
await setImmediate();
await setImmediate();
collect(observer.takeRecords());
observer.disconnect();
close();
input.destroy();
assert.equal(delivered, iterations);
assert.equal(deliveredBytes, iterations * frame.length);
assert.deepEqual(last, frame);
if (values.decode) {
  assert.deepEqual(parsed, JSON.parse(frame.toString("utf8")));
}
console.log(
  JSON.stringify({
    mode: values.decode ? "frame-and-decode" : "framing",
    ownerSha256,
    sample: values.sample,
    iterations,
    frameBytes: frame.length,
    chunksPerFrame: chunks.length,
    delivered,
    deliveredBytes,
    hostLoad,
    elapsedMs: end - start,
    threadCpuUsPerFrame: (used.user + used.system) / iterations,
    allocatedBytesPerFrame: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    gc: {
      count: collections.length,
      totalMs: collections.reduce((sum, ms) => sum + ms, 0),
      maxMs: Math.max(0, ...collections),
    },
    rss: process.memoryUsage().rss,
    heapUsed: process.memoryUsage().heapUsed,
  }),
);
