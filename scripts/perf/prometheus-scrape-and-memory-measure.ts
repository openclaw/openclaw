// node --import ./scripts/tsx.mjs scripts/perf/prometheus-scrape-and-memory-measure.ts
// Compare five fresh A/B/A triplets with matching digests and response backing
// overhead below 4 KiB. Require lower allocation and no material CPU or wall-time regression.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadavg } from "node:os";
import {
  familyBudgetPopulation,
  populateFamilyBudget,
} from "../../extensions/diagnostics-prometheus/src/family-budget.test-support.js";
import { measureSynchronous } from "../../extensions/diagnostics-prometheus/src/metric-store-record-measure.test-support.js";
import { createPrometheusMetricStore } from "../../extensions/diagnostics-prometheus/src/prometheus-metric-store.js";
import { recordMemorySample } from "../../extensions/diagnostics-prometheus/src/service-memory.js";

const store = createPrometheusMetricStore();
populateFamilyBudget(store, familyBudgetPopulation());
const workerHeaps = Array.from({ length: 16 }, (_, index) => ({
  script: `synthetic-worker-${index % 8}.js`,
  workerSlot: index + 1,
  heapUsed: 12_000_000,
  heapTotal: 20_000_000,
  heapSizeLimitBytes: 1_000_000_000,
  external: 10_000,
  arrayBuffers: 1_000,
  heapSpaces: Array.from({ length: 8 }, (_unused, space) => ({
    space_name: `space_${space}`,
    space_used_size: 1_000,
  })),
}));
const memory = {
  rssBytes: 900_000_000,
  heapUsedBytes: 40_000_000,
  heapTotalBytes: 50_000_000,
  heapSizeLimitBytes: 2_000_000_000,
  oldGenerationAfterGcBytes: 20_000_000,
  externalBytes: 25_000_000,
  arrayBuffersBytes: 8_000_000,
  anonymousRssBytes: 400_000_000,
  anonymousSwapBytes: 0,
  workerCount: workerHeaps.length,
  workerHeapSampledCount: workerHeaps.length,
  workerHeaps,
  heapSpaces: workerHeaps[0]!.heapSpaces.map(({ space_name, space_used_size }) => ({
    space_name,
    space_used_size,
    space_size: 2_000,
    space_available_size: 1_000,
    physical_space_size: 2_000,
  })),
};
const buckets = [1_000_000, 100_000_000, 1_000_000_000];
function record(count: number) {
  for (let index = 0; index < count; index++) {
    memory.heapUsedBytes = 40_000_000 + index;
    recordMemorySample(store, memory, buckets);
  }
}

const hostLoad = loadavg();
record(400);
const recording = measureSynchronous(() => record(2000));
const describe = (body: Buffer) => ({
  bytes: body.length,
  backingBytes: body.buffer.byteLength,
  sha256: createHash("sha256").update(body).digest("hex"),
});
const first = store.render();
const output = describe(first);
first.buffer.transfer(0);
const scrapes = (count: number, changing: boolean) => {
  let bytes = 0;
  let backingBytes = 0;
  for (let index = 0; index < count; index++) {
    if (changing) {
      store.gauge(
        "openclaw_gateway_ws_operator_connections",
        "Synthetic live connections",
        {},
        index % 2 ? 99 : 100,
      );
    }
    const body = store.render();
    bytes += body.length;
    backingBytes += body.buffer.byteLength;
    body.buffer.transfer(0);
  }
  return { bytes, backingBytes };
};
scrapes(50, false);
const warm = measureSynchronous(() => scrapes(200, false));
scrapes(50, true);
const changing = measureSynchronous(() => scrapes(200, true));
const final = describe(store.render());
assert.equal(warm.result.bytes, output.bytes * 200);
assert(warm.result.backingBytes - warm.result.bytes < 200 * 4096);
assert(changing.result.backingBytes - changing.result.bytes < 200 * 4096);
console.log(JSON.stringify({ hostLoad, output, final, recording, warm, changing }));
