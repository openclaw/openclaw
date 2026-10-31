// Bounded, untraced owner mode for metric-store.benchmark.test-support.ts.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { getHeapStatistics } from "node:v8";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

function measureSynchronous<T>(run: () => T) {
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocatedBefore), "Requires Node 26.12+ allocation counters");
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  const result = run();
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  return { result, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, allocatedBytes };
}

export async function measureRecords(options: {
  output: string;
  iterations: number;
  renderSamples: number;
  store: PrometheusMetricStore;
  fixture: { histogramSeries: number; scalarSeries: number; workload: string };
  update: () => void;
  updateAll: () => void;
  scrapeInfo: (scrape: ReturnType<PrometheusMetricStore["render"]>) => unknown;
  releaseScrape: (scrape: ReturnType<PrometheusMetricStore["render"]>) => void;
}) {
  const {
    output,
    iterations,
    renderSamples,
    store,
    fixture,
    update,
    updateAll,
    scrapeInfo,
    releaseScrape,
  } = options;
  const initial = store.render();
  const initialScrape = scrapeInfo(initial);
  await writeFile(`${output}.initial.prom`, initial);
  releaseScrape(initial);
  const recordUpdates = () => {
    for (let index = 0; index < iterations; index++) {
      update();
    }
    return iterations;
  };
  for (let warmup = 0; warmup < 5; warmup++) {
    recordUpdates();
    updateAll();
    releaseScrape(store.render());
  }
  const hostLoadBefore = loadavg();
  const { result: operations, ...record } = measureSynchronous(recordUpdates);
  const scrapes = [];
  for (let index = 0; index < renderSamples; index++) {
    // The full cycle includes one update per series; scrape timing isolates deferred work.
    const { result: rendered, ...cycle } = measureSynchronous(() => {
      updateAll();
      return measureSynchronous(() => store.render());
    });
    const { result, ...measurement } = rendered;
    scrapes.push({ ...measurement, cycle });
    releaseScrape(result);
  }
  const final = store.render();
  const finalScrape = scrapeInfo(final);
  await writeFile(`${output}.final.prom`, final);
  releaseScrape(final);
  await writeFile(
    output,
    JSON.stringify(
      {
        node: process.version,
        mode: "record-only",
        profiled: false,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
        fixture,
        series: fixture.histogramSeries + fixture.scalarSeries,
        initialScrape,
        record: {
          operations,
          ...record,
          cpuMsPerOperation: record.cpuMs / iterations,
          allocatedBytesPerOperation: record.allocatedBytes / iterations,
        },
        dirtyScrapes: scrapes,
        finalScrape,
      },
      null,
      2,
    ) + "\n",
  );
}
