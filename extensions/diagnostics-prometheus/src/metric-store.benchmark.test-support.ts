// Run on an approved benchmark host with --expose-gc --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceNodeEntry,
} from "node:perf_hooks";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import {
  MAX_PROMETHEUS_FAMILY_SERIES,
  PROMETHEUS_FAMILY_RESERVES,
  SHARED_PROMETHEUS_SERIES,
  type PrometheusMetricName,
} from "./prometheus-family-budget.js";
import {
  createPrometheusMetricStore,
  type PrometheusMetricStore,
} from "./prometheus-metric-store.js";
import { recordWorkerRequest } from "./service-worker.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "pool-churn": { type: "boolean", default: false },
    "heap-snapshot": { type: "string" },
    iterations: { type: "string", default: "100000" },
    "render-only": { type: "boolean", default: false },
    http: { type: "boolean", default: false },
    "http-only": { type: "boolean", default: false },
    "http-port": { type: "string" },
    "flush-headers": { type: "boolean", default: false },
    "render-samples": { type: "string", default: "200" },
    "allocation-renders": { type: "string", default: "100" },
    "updates-per-render": { type: "string", default: "0" },
    shape: { type: "string" },
    "start-at": { type: "string" },
    "phase-ms": { type: "string", default: "60000" },
  },
});
assert(values.output, "--output is required");
assert(globalThis.gc, "Run with --expose-gc");
function integerOption(value: string, name: string, min: number, max: number) {
  const parsed = Number(value);
  assert(
    Number.isSafeInteger(parsed) && parsed >= min && parsed <= max,
    `${name}: expected ${min}..${max}`,
  );
  return parsed;
}
const iterations = integerOption(values.iterations, "--iterations", 1000, 10000000);
const renderSamples = integerOption(values["render-samples"], "--render-samples", 200, 100000);
const allocationRenders = integerOption(
  values["allocation-renders"],
  "--allocation-renders",
  1,
  100000,
);
const phaseMs = integerOption(values["phase-ms"], "--phase-ms", 1000, 3600000);
const updatesPerRender = integerOption(
  values["updates-per-render"],
  "--updates-per-render",
  0,
  16384,
);
assert(!updatesPerRender || values.shape, "--updates-per-render requires --shape");
const withHttp = values.http || values["http-only"];
const httpPort = values["http-port"]
  ? integerOption(values["http-port"], "--http-port", 40000, 65535)
  : undefined;
assert(!values["heap-snapshot"] || !withHttp, "Heap snapshots are a separate retention-only pass");
assert(!withHttp || httpPort, "--http-port is required with --http or --http-only");
const startAt = values["start-at"] ? Number(values["start-at"]) : Date.now() + 30000;
assert(Number.isSafeInteger(startAt), "--start-at must be an epoch millisecond integer");
const capacity =
  Object.values(PROMETHEUS_FAMILY_RESERVES).reduce((sum, reserve) => sum + reserve, 0) +
  SHARED_PROMETHEUS_SERIES;
const results: Record<string, unknown> = {};
let phaseIndex = 0;
const session = new Session();
session.connect();
await session.post("HeapProfiler.enable");

async function phaseStart(name: string) {
  const remaining = startAt + phaseIndex++ * phaseMs - Date.now();
  assert(remaining > 0, `Missed the paired ${name} start; increase --start-at or --phase-ms`);
  await delay(remaining);
}

function tails(durations: number[]) {
  durations.sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    durations[Math.ceil(durations.length * fraction) - 1] ?? null;
  return {
    samples: durations.length,
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: durations.at(-1) ?? null,
    p95Eligible: durations.length >= 200,
    p99Eligible: durations.length >= 1000,
  };
}

async function retainedMemory() {
  globalThis.gc!();
  await immediate();
  globalThis.gc!();
  return process.memoryUsage();
}

function memoryDelta(after: NodeJS.MemoryUsage, before: NodeJS.MemoryUsage) {
  return {
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

async function measure(
  name: string,
  operations: number,
  run: () => void | Promise<void>,
  profiled = true,
) {
  await phaseStart(name);
  await retainedMemory();
  const gcPauses = { minor: [] as number[], major: [] as number[], other: [] as number[] };
  let started = Infinity;
  let ended = Infinity;
  const observer = new PerformanceObserver((list) => {
    // The observer subscribes only to Node's GC entries, which carry kind in detail.
    for (const entry of list.getEntries() as PerformanceNodeEntry[]) {
      if (entry.startTime < started || entry.startTime >= ended) {
        continue;
      }
      const detail: { kind: number } = entry.detail;
      const kind =
        detail.kind === constants.NODE_PERFORMANCE_GC_MINOR
          ? "minor"
          : detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR
            ? "major"
            : "other";
      gcPauses[kind].push(entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  if (profiled) {
    await session.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  // These markers delimit only measured work in an optional --trace-gc-nvp log.
  console.error(JSON.stringify({ benchmarkPhase: name, event: "start", profiled, operations }));
  const cpu = process.cpuUsage();
  const eventLoop = monitorEventLoopDelay({ resolution: 1 });
  eventLoop.enable();
  started = performance.now();
  await run();
  ended = performance.now();
  const used = process.cpuUsage(cpu);
  eventLoop.disable();
  console.error(JSON.stringify({ benchmarkPhase: name, event: "end" }));
  let sampledHeapBytes: number | undefined;
  if (profiled) {
    const { profile } = await session.post("HeapProfiler.stopSampling");
    type AllocationNode = { selfSize: number; children: AllocationNode[] };
    const allocated = (node: AllocationNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
    sampledHeapBytes = allocated(profile.head);
  }
  await immediate();
  await immediate();
  observer.disconnect();
  const allPauses = [...gcPauses.minor, ...gcPauses.major, ...gcPauses.other];
  const gc = {
    total: tails(allPauses),
    minor: tails(gcPauses.minor),
    major: tails(gcPauses.major),
    other: tails(gcPauses.other),
    majorEligible: gcPauses.major.length >= 50,
  };
  const cpuMs = (used.user + used.system) / 1000;
  results[name] = {
    operations,
    profiled,
    sampledHeapBytes,
    sampledHeapBytesPerOperation:
      sampledHeapBytes === undefined ? undefined : sampledHeapBytes / operations,
    wallMs: ended - started,
    cpuMs,
    cpuMsPerOperation: cpuMs / operations,
    gc,
    gcMsPerOperation: gc.total.totalMs / operations,
    eventLoop: {
      samples: eventLoop.count,
      p95Ms: eventLoop.count ? eventLoop.percentile(95) / 1e6 : null,
      p99Ms: eventLoop.count ? eventLoop.percentile(99) / 1e6 : null,
      maxMs: eventLoop.count ? eventLoop.max / 1e6 : null,
      p95Eligible: eventLoop.count >= 200,
      p99Eligible: eventLoop.count >= 1000,
    },
  };
}

type Shape = {
  histograms: { name: PrometheusMetricName; labelSets: number; finiteBuckets: number[] }[];
  scalars: { name: PrometheusMetricName; labelSets: number; type: "counter" | "gauge" }[];
};
function parseShape(raw: unknown): Shape {
  assert(
    raw && typeof raw === "object" && "histograms" in raw && "scalars" in raw,
    "Invalid shape",
  );
  assert(
    Array.isArray(raw.histograms) && Array.isArray(raw.scalars),
    "Shape must contain histogram and scalar arrays",
  );
  let total = 0;
  const names = new Set<string>();
  const series = (row: unknown) => {
    assert(
      row && typeof row === "object" && "name" in row && "labelSets" in row,
      "Invalid series shape",
    );
    assert(
      typeof row.name === "string" && Object.hasOwn(PROMETHEUS_FAMILY_RESERVES, row.name),
      "Unknown metric name",
    );
    assert(!names.has(row.name), `Duplicate family ${row.name}`);
    names.add(row.name);
    const name = row.name as PrometheusMetricName;
    assert(typeof row.labelSets === "number", "labelSets must be numeric");
    const labelSets = integerOption(
      String(row.labelSets),
      "labelSets",
      1,
      Math.max(MAX_PROMETHEUS_FAMILY_SERIES, PROMETHEUS_FAMILY_RESERVES[name]),
    );
    total += labelSets;
    return { name, labelSets };
  };
  const histograms: Shape["histograms"] = raw.histograms.map((row: unknown) => {
    const common = series(row);
    assert(
      row && typeof row === "object" && "finiteBuckets" in row && Array.isArray(row.finiteBuckets),
      "Invalid histogram bounds",
    );
    const finiteBuckets = row.finiteBuckets.map((bound: unknown) => {
      assert(
        typeof bound === "number" && Number.isFinite(bound),
        "Histogram bounds must be finite",
      );
      return bound;
    });
    assert(
      finiteBuckets.length > 0 &&
        finiteBuckets.length <= 128 &&
        finiteBuckets.every((bound, index) => index === 0 || bound > finiteBuckets[index - 1]!),
      "Histogram bounds must be sorted and unique",
    );
    return { ...common, finiteBuckets };
  });
  const scalars: Shape["scalars"] = raw.scalars.map((row: unknown) => {
    const common = series(row);
    assert(
      row &&
        typeof row === "object" &&
        "type" in row &&
        (row.type === "counter" || row.type === "gauge"),
      "Invalid scalar type",
    );
    return { ...common, type: row.type };
  });
  assert(total <= capacity, "Shape exceeds store capacity");
  return { histograms, scalars };
}

// Dead traffic between new series exposes long-lived views pinning unrelated pool slabs.
const churnPool = () => values["pool-churn"] && Buffer.from("x".repeat(8192));

function populateShape(store: PrometheusMetricStore, shape: Shape) {
  for (const { name, labelSets, finiteBuckets } of shape.histograms) {
    for (let index = 0; index < labelSets; index++) {
      churnPool();
      store.histogram(
        name,
        "Synthetic histogram",
        { kind: `kind-${index % 8}`, worker_slot: String(index) },
        0.005 * ((index % 17) + 1),
        finiteBuckets,
      );
    }
  }
  for (const { name, labelSets, type } of shape.scalars) {
    for (let index = 0; index < labelSets; index++) {
      churnPool();
      store[type](
        name,
        "Synthetic scalar",
        { kind: `kind-${index % 8}`, worker_slot: String(index) },
        index + 1,
      );
    }
  }
  return {
    histogramSeries: shape.histograms.reduce((sum, row) => sum + row.labelSets, 0),
    scalarSeries: shape.scalars.reduce((sum, row) => sum + row.labelSets, 0),
    workload:
      "Observed family cardinalities and bucket widths, synthetic labels and values; exporter drop counters omitted.",
  };
}

function shapeUpdater(store: PrometheusMetricStore, shape: Shape | undefined) {
  const updates: ((round: number) => void)[] = [];
  if (shape && updatesPerRender) {
    for (const { name, labelSets, finiteBuckets } of shape.histograms) {
      for (let index = 0; index < labelSets; index++) {
        const labels = { kind: `kind-${index % 8}`, worker_slot: String(index) };
        updates.push(() =>
          store.histogram(name, "Synthetic histogram", labels, 0.015, finiteBuckets),
        );
      }
    }
    for (const { name, labelSets, type } of shape.scalars) {
      for (let index = 0; index < labelSets; index++) {
        const labels = { kind: `kind-${index % 8}`, worker_slot: String(index) };
        updates.push((round) => store[type](name, "Synthetic scalar", labels, round + 1));
      }
    }
    assert(updatesPerRender <= updates.length, "Cannot update more series than the shape contains");
  }
  let cursor = 0;
  return () => {
    for (let index = 0; index < updatesPerRender; index++) {
      updates[cursor % updates.length]!(cursor++);
    }
  };
}

function populateCapacity(store: PrometheusMetricStore) {
  const families = Object.keys(PROMETHEUS_FAMILY_RESERVES) as PrometheusMetricName[];
  const maxReserve = Math.max(...Object.values(PROMETHEUS_FAMILY_RESERVES));
  const rpcDurationBuckets = [
    0.005, 0.01, 0.0125, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.125, 0.15, 0.2,
    0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12.5, 15, 20, 25, 30,
    60, 120, 300, 600,
  ];
  const responseByteBuckets = Array.from({ length: 17 }, (_, index) => 1024 * 2 ** index);
  const rpcBuckets: Partial<Record<PrometheusMetricName, number[]>> = {
    openclaw_gateway_rpc_admission_seconds: rpcDurationBuckets,
    openclaw_gateway_rpc_first_response_seconds: rpcDurationBuckets,
    openclaw_gateway_rpc_handler_seconds: rpcDurationBuckets,
    openclaw_gateway_rpc_queue_wait_seconds: rpcDurationBuckets,
    openclaw_gateway_rpc_response_bytes: responseByteBuckets,
    openclaw_gateway_rpc_handler_heap_delta_bytes: [
      ...responseByteBuckets.toReversed().map((bytes) => -bytes),
      0,
      ...responseByteBuckets,
    ],
  };
  let series = 0;
  let scalarSeries = 0;
  let histogramSeries = 0;
  // Populate every reserve before using shared capacity, up to the loaded budget.
  for (let pass = 0; series < capacity; pass++) {
    for (const [familyIndex, name] of families.entries()) {
      const reserve = PROMETHEUS_FAMILY_RESERVES[name];
      const label = pass < maxReserve ? pass : reserve + pass - maxReserve;
      if (
        (pass < maxReserve && pass >= reserve) ||
        label >= Math.max(MAX_PROMETHEUS_FAMILY_SERIES, reserve)
      ) {
        continue;
      }
      if (series === capacity) {
        break;
      }
      churnPool();
      const labels = { kind: `kind-${label % 8}`, worker_slot: String(label) };
      const buckets = rpcBuckets[name];
      if (buckets || familyIndex % 4 >= 2) {
        store.histogram(name, "Retained histogram", labels, 0.005, buckets);
        histogramSeries++;
      } else if (familyIndex % 4 === 0) {
        store.counter(name, "Retained counter", labels);
        scalarSeries++;
      } else {
        store.gauge(name, "Retained gauge", labels, 2);
        scalarSeries++;
      }
      series++;
    }
  }
  return {
    histogramSeries,
    scalarSeries,
    workload:
      "Mixed scalar/histogram saturation with production RPC bucket widths; not a traffic replay.",
  };
}

type Scrape = string | Buffer<ArrayBuffer>;

function releaseScrape(scrape: Scrape) {
  if (Buffer.isBuffer(scrape)) {
    scrape.buffer.transfer(0);
  }
}

function scrapeInfo(scrape: Scrape) {
  return {
    sha256: createHash("sha256").update(scrape).digest("hex"),
    bytes: Buffer.byteLength(scrape),
    bufferByteLength: Buffer.isBuffer(scrape) ? scrape.buffer.byteLength : 0,
    outputType: Buffer.isBuffer(scrape) ? "buffer" : "string",
    renderedRows: scrape
      .toString()
      .split("\n")
      .filter((line) => line && !line.startsWith("#")).length,
  };
}

async function measureHttp(
  store: PrometheusMetricStore,
  expectedBytes: number,
  port: number,
  update: () => void,
) {
  let served = 0;
  // Mirror the authorized GET response path; service tests cover routing and authorization.
  const server = createServer((_req, res) => {
    update();
    const body: Scrape = store.render();
    served++;
    res.statusCode = 200;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.setHeader("Content-Length", String(Buffer.byteLength(body)));
    if (values["flush-headers"]) {
      res.flushHeaders();
    }
    if (Buffer.isBuffer(body)) {
      res.end(body, (error?: Error | null) => {
        if (!error) {
          releaseScrape(body);
        }
      });
    } else {
      // The baseline string response has no completion closure retaining its body.
      res.end(body);
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  // A child process keeps client CPU and heap allocation out of server measurements.
  const client = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { Agent, get } from "node:http";
    const [port, expectedBytes] = process.argv.slice(1).map(Number);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    process.on("message", async (count) => {
      try {
        let totalBytes = 0;
        const durations = [];
        for (let index = 0; index < count; index++) {
          const started = performance.now();
          const response = await new Promise((resolve, reject) => {
            const request = get({ host: "127.0.0.1", port, path: "/metrics", agent }, resolve);
            request.on("error", reject);
            request.setTimeout(30000, () => request.destroy(new Error("HTTP request timed out")));
          });
          assert.equal(response.statusCode, 200);
          let bytes = 0;
          for await (const chunk of response) bytes += chunk.length;
          durations.push(performance.now() - started);
          assert(bytes > 0);
          if (expectedBytes) assert.equal(bytes, expectedBytes);
          totalBytes += bytes;
        }
        process.send({ totalBytes, durations });
      } catch (error) {
        process.send({ error: String(error) });
      }
    });
    process.send({ ready: true });
  `,
      String(port),
      String(expectedBytes),
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = once(client, "exit");
  const failed = exited.then(([code, signal]) => {
    throw new Error(`HTTP client exited (${code ?? signal})`);
  });
  type Reply = { ready?: boolean; error?: string; totalBytes: number; durations: number[] };
  const receive = async () => {
    const [reply] = await Promise.race([once(client, "message"), failed]);
    return reply as Reply;
  };
  const request = async (count: number) => {
    const reply = receive();
    client.send(count);
    const result = await reply;
    assert(!result.error, result.error);
    assert.equal(result.durations.length, count);
    if (expectedBytes) {
      assert.equal(result.totalBytes, count * expectedBytes);
    }
    return result;
  };
  try {
    assert((await receive()).ready, "HTTP client did not initialize");
    await request(10);
    for (const [name, count, profiled] of [
      ["prometheus.http", renderSamples, false],
      ["prometheus.http-allocation", allocationRenders, true],
    ] as const) {
      let reply: Reply | undefined;
      const previousServed = served;
      await measure(
        name,
        count,
        async () => {
          reply = await request(count);
        },
        profiled,
      );
      assert(reply);
      assert.equal(served - previousServed, count);
      results[`${name}.client`] = {
        receivedBytes: reply.totalBytes,
        serverRenders: served - previousServed,
        latency: tails(reply.durations),
      };
    }
  } finally {
    client.kill();
    try {
      await exited;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

try {
  if (!values["render-only"] && !values["http-only"]) {
    const store = createPrometheusMetricStore();
    const observe = (count: number) => {
      for (let index = 0; index < count; index++) {
        const labels =
          index % 2
            ? { kind: "sqlite_read", phase: "completed" }
            : { phase: "completed", kind: "sqlite_read" };
        store.counter("openclaw_worker_tasks_completed_total", "Synthetic count", labels);
        store.gauge("openclaw_worker_queue_depth", "Synthetic depth", labels, 2);
        store.histogram("openclaw_worker_request_seconds", "Synthetic duration", labels, 0.005);
      }
    };
    observe(2000);
    await measure("prometheus.observation", iterations * 3, () => observe(iterations));
    const workerStore = createPrometheusMetricStore();
    const record = (count: number) => {
      for (let index = 0; index < count; index++) {
        recordWorkerRequest(workerStore, {
          type: "worker.request",
          ts: 1,
          seq: index,
          kind: "sqlite_read",
          phase: "completed",
          requestClass: "sessions.get",
          queueDepth: 0,
          queueWaitMs: 0.1,
          durationMs: 1,
        });
      }
    };
    record(2000);
    await measure("prometheus.worker-request", iterations, () => record(iterations));
  }
  const fixed = createPrometheusMetricStore();
  for (const labels of [
    { z: 'quote"backslash\\newline\n雪', a: "" },
    { a: "", z: 'quote"backslash\\newline\n雪' },
    { a: "one|two", z: "three" },
    { z: "two|three", a: "one" },
  ]) {
    fixed.counter("openclaw_run_completed_total", "Synthetic \\ help\n", labels, 2);
    fixed.counterValue("openclaw_worker_tasks_completed_total", "Absolute", labels, 4);
    fixed.gauge("openclaw_worker_queue_depth", "Depth", labels, -2);
    fixed.histogram("openclaw_run_duration_seconds", "Duration", labels, 0.015);
  }
  const fixedScrape = scrapeInfo(fixed.render());
  await writeFile(`${values.output}.fixed.prom`, fixed.render());
  if (!values["render-only"] && !values["http-only"]) {
    const renders = Math.max(1000, Math.floor(iterations / 10));
    await measure("prometheus.render", renders, () => {
      for (let index = 0; index < renders; index++) {
        releaseScrape(fixed.render());
      }
    });
  }
  const shape = values.shape
    ? parseShape(JSON.parse(await readFile(values.shape, "utf8")))
    : undefined;
  const retainedStore = createPrometheusMetricStore();
  // Keep synthetic event input outside the measured store-retention delta.
  const update = shapeUpdater(retainedStore, shape);
  const emptyMemory = await retainedMemory();
  const fixture = shape ? populateShape(retainedStore, shape) : populateCapacity(retainedStore);
  const populatedMemory = await retainedMemory();
  // Full-byte verification and file writes are deliberately outside measured phases.
  const fullScrape = scrapeInfo(retainedStore.render());
  assert(
    !retainedStore.render().includes("openclaw_prometheus_series_dropped_total"),
    "Fixture unexpectedly dropped series",
  );
  await writeFile(`${values.output}.prom`, retainedStore.render());
  for (let index = 0; index < 10; index++) {
    retainedStore.render();
  }
  const warmedMemory = await retainedMemory();
  if (values["heap-snapshot"]) {
    writeHeapSnapshot(values["heap-snapshot"]);
  }
  let consumedUnits = 0;
  if (!values["http-only"] && !values["heap-snapshot"]) {
    const durations = new Float64Array(renderSamples);
    await measure(
      "prometheus.full-capacity-render",
      renderSamples,
      () => {
        for (let index = 0; index < renderSamples; index++) {
          update();
          const before = performance.now();
          const rendered = retainedStore.render();
          durations[index] = performance.now() - before;
          consumedUnits += rendered.length;
          releaseScrape(rendered);
        }
      },
      false,
    );
    results.renderLatency = tails(Array.from(durations));
    await measure("prometheus.render-allocation", allocationRenders, () => {
      for (let index = 0; index < allocationRenders; index++) {
        update();
        const rendered = retainedStore.render();
        consumedUnits += rendered.length;
        releaseScrape(rendered);
      }
    });
  }
  const afterRenderMemory = await retainedMemory();
  if (withHttp) {
    assert(httpPort);
    await measureHttp(retainedStore, updatesPerRender ? 0 : fullScrape.bytes, httpPort, update);
    results.afterHttp = memoryDelta(await retainedMemory(), afterRenderMemory);
  }
  const finalScrape = scrapeInfo(retainedStore.render());
  if (!updatesPerRender) {
    assert.equal(finalScrape.sha256, fullScrape.sha256, "Measured renders changed the scrape");
  }
  await writeFile(`${values.output}.final.prom`, retainedStore.render());
  retainedStore.reset();
  const afterResetMemory = await retainedMemory();
  assert.equal(retainedStore.render().length, 0);
  results.retained = {
    ...fixture,
    series: fixture.scalarSeries + fixture.histogramSeries,
    populated: memoryDelta(populatedMemory, emptyMemory),
    warmed: memoryDelta(warmedMemory, emptyMemory),
    afterRender: memoryDelta(afterRenderMemory, warmedMemory),
    afterReset: memoryDelta(afterResetMemory, emptyMemory),
  };
  await writeFile(
    values.output,
    JSON.stringify(
      {
        node: process.version,
        iterations,
        renderSamples,
        poolChurn: values["pool-churn"],
        allocationRenders,
        updatesPerRender,
        http: withHttp,
        httpOnly: values["http-only"],
        flushHeaders: values["flush-headers"],
        phaseMs,
        samplingInterval: 4096,
        includeCollectedObjects: true,
        consumedUnits,
        results,
        scrape: fullScrape,
        fixedScrape,
        finalScrape,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  session.disconnect();
}
