/**
 * node --expose-gc scripts/perf/remote-catalog-inheritance-measure.mjs
 *   [--samples 5] [--workers 8] [--models 10000] [--readers 1]
 * Fresh processes alternate the previous environment-data representation and the
 * production snapshot owner. Workers exercise Node's actual inheritance boundary.
 * This measures catalog inheritance, not whole-Gateway RSS or provider discovery.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
  getEnvironmentData,
  setEnvironmentData,
} from "node:worker_threads";

const {
  publishRemoteModelCatalogStartupPublication: publish,
  readRemoteModelCatalogStartupPublication: read,
} = await import("../../src/model-catalog/remote-startup-snapshot.ts");
const key = "openclaw.remoteModelCatalogStartupSnapshot";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

if (!isMainThread) {
  const inheritedModels = getEnvironmentData(key).catalog?.providers.fixture.models.length ?? 0;
  assert.equal(inheritedModels, workerData.mode === "baseline" ? workerData.models : 0);
  const before = performance.now();
  const catalog = workerData.reader
    ? workerData.mode === "baseline"
      ? getEnvironmentData(key).catalog
      : read()
    : undefined;
  const readMs = performance.now() - before;
  const checksum = catalog ? digest(catalog) : undefined;
  if (workerData.reader && workerData.mode === "candidate") {
    assert.equal(read(), catalog, "Repeated reads must preserve snapshot identity");
  }
  const cpu = process.threadCpuUsage();
  parentPort.postMessage({
    readMs,
    checksum,
    cpuMs: (cpu.user + cpu.system) / 1000,
    materializedModels: getEnvironmentData(key).catalog?.providers.fixture.models.length ?? 0,
  });
  parentPort.once("message", () => {
    global.gc();
    parentPort.postMessage({ heapUsed: process.memoryUsage().heapUsed });
    parentPort.on("message", () => {});
  });
} else {
  const { values } = parseArgs({
    options: {
      samples: { type: "string", default: "5" },
      workers: { type: "string", default: "8" },
      models: { type: "string", default: "10000" },
      readers: { type: "string", default: "1" },
      mode: { type: "string" },
      sample: { type: "boolean" },
    },
  });
  const count = (key) => {
    const value = Number(values[key]);
    assert(Number.isSafeInteger(value) && value >= (key === "readers" ? 0 : 1));
    return value;
  };
  const workers = count("workers"),
    models = count("models"),
    readers = count("readers");
  assert(readers <= workers);
  assert(global.gc, "Run with --expose-gc");
  if (values.sample) {
    assert(["baseline", "candidate"].includes(values.mode));
    const catalog = {
      sourceUrl: "https://catalog.invalid",
      revision: "fixture",
      generatedAt: 1,
      providers: {
        fixture: {
          models: Array.from({ length: models }, (_, index) => ({
            id: `model-${index}`,
            name: `Model ${index}`,
            contextWindow: 128000,
            maxTokens: 8192,
            input: ["text"],
            cost: { input: 1, output: 2 },
          })),
        },
      },
      recommendations: {},
      pricing: {},
      upstreamPricing: {},
    };
    const expected = digest(catalog);
    global.gc();
    const hostLoad = loadavg();
    const rssBefore = process.memoryUsage.rss();
    const cpuBefore = process.threadCpuUsage();
    const publishedAt = performance.now();
    if (values.mode === "baseline") setEnvironmentData(key, { catalog });
    else publish(catalog);
    const publishMs = performance.now() - publishedAt;
    const publishCpu = process.threadCpuUsage(cpuBefore);
    const active = [];
    const results = [];
    let readyMs = publishMs;
    try {
      for (let index = 0; index < workers; index++) {
        const started = performance.now();
        const hostCpuBefore = process.threadCpuUsage();
        const worker = new Worker(new URL(import.meta.url), {
          workerData: {
            mode: values.mode,
            reader: index < readers,
            models,
          },
        });
        const constructorMs = performance.now() - started;
        let onlineMs;
        worker.once("online", () => {
          onlineMs = performance.now() - started;
        });
        active.push(worker);
        const [result] = await once(worker, "message");
        result.readyMs = performance.now() - started;
        result.constructorMs = constructorMs;
        result.onlineMs = onlineMs;
        readyMs += result.readyMs;
        const hostCpu = process.threadCpuUsage(hostCpuBefore);
        result.cpuMs += (hostCpu.user + hostCpu.system) / 1000;
        if (index < readers) assert.equal(result.checksum, expected);
        const memory = once(worker, "message");
        worker.postMessage("measure");
        const [retained] = await memory;
        results.push({ ...result, ...retained });
      }
      console.log(
        JSON.stringify({
          mode: values.mode,
          workers,
          readers,
          models,
          hostLoad,
          hostLoadAfter: loadavg(),
          workerSamples: results,
          readyMs,
          cpuMs:
            (publishCpu.user + publishCpu.system) / 1000 +
            results.reduce((sum, row) => sum + row.cpuMs, 0),
          publishMs,
          readerMs: results.reduce((sum, row) => sum + row.readMs, 0),
          materializedModels: results.reduce((sum, row) => sum + row.materializedModels, 0),
          workerHeapBytes: results.reduce((sum, row) => sum + row.heapUsed, 0),
          rssDeltaBytes: process.memoryUsage.rss() - rssBefore,
        }),
      );
    } finally {
      await Promise.all(active.map((worker) => worker.terminate()));
    }
  } else {
    const results = [];
    for (let sample = 0; sample < count("samples"); sample++) {
      for (const mode of sample % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
        const child = spawnSync(
          process.execPath,
          [
            "--expose-gc",
            fileURLToPath(import.meta.url),
            "--sample",
            "--mode",
            mode,
            "--workers",
            String(workers),
            "--models",
            String(models),
            "--readers",
            String(readers),
          ],
          { encoding: "utf8", timeout: 120000 },
        );
        assert.equal(child.status, 0, child.stderr);
        results.push(JSON.parse(child.stdout));
      }
    }
    const summary = Object.fromEntries(
      ["baseline", "candidate"].map((mode) => [
        mode,
        Object.fromEntries(
          [
            "readyMs",
            "cpuMs",
            "publishMs",
            "readerMs",
            "materializedModels",
            "workerHeapBytes",
            "rssDeltaBytes",
          ].map((metric) => {
            const sorted = results
              .filter((row) => row.mode === mode)
              .map((row) => row[metric])
              .sort((a, b) => a - b);
            return [
              metric,
              {
                median: sorted[Math.floor(sorted.length / 2)],
                p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
                min: sorted[0],
                max: sorted.at(-1),
              },
            ];
          }),
        ),
      ]),
    );
    console.log(JSON.stringify({ node: process.version, summary, samples: results }));
  }
}
