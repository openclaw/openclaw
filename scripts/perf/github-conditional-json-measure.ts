/**
 * GitHub JSON owner proof with a loopback mock server, 40 resources and two credentials.
 * node --import ./scripts/tsx.mjs scripts/perf/github-conditional-json-measure.ts <module.ts> [3000] [--allocations]
 * Run base/candidate in AB/BA order. Warm each representation before measuring.
 * Acceptance: identical results, zero warm 304 body/parse/quota work, lower CPU and
 * sampled allocation per poll. Allocation passes are separate from timing/GC passes.
 * The mock models authenticated GitHub 304 primary-quota exemption, not live billing.
 * Optional --expose-gc reports post-work retained heap in a separate run.
 * No Gateway/Team load or real credentials; server and client CPU are both included.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
assert(modulePath);
const iterations = Number(process.argv[3] ?? 3000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const allocations = process.argv.includes("--allocations");
const { fetchGitHubJson } = await import(pathToFileURL(resolve(modulePath)).href);
const payload = JSON.stringify({
  total_count: 100,
  check_runs: Array.from({ length: 100 }, (_, id) => ({
    id,
    name: `synthetic-check-${id}`,
    status: "completed",
    conclusion: "success",
    output: { title: "Synthetic check", summary: "test detail ".repeat(24) },
  })),
});
let bytes = 0;
let charged = 0;
let requests = 0;
let parses = 0;
const server = createServer((req, res) => {
  requests++;
  assert(req.headers.authorization?.startsWith("Bearer synthetic-"));
  const etag = '"fixture-v1"';
  res.setHeader("etag", etag);
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304).end();
  } else {
    charged++;
    bytes += Buffer.byteLength(payload);
    res.writeHead(200, { "content-type": "application/json" }).end(payload);
  }
});
server.listen(44535, "127.0.0.1");
await once(server, "listening");
const transport: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  return fetch(`http://127.0.0.1:44535${url.pathname}${url.search}`, init);
};
const inspector = new Session();
const gc: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push(entry.duration);
  }
});
observer.observe({ entryTypes: ["gc"] });
const parse = JSON.parse;
try {
  const run = async (count: number, latencies?: number[]) => {
    for (let index = 0; index < count; index++) {
      const started = performance.now();
      const value = await fetchGitHubJson(
        `https://api.github.com/repos/synthetic/repo-${index % 40}/commits/head/check-runs`,
        transport,
        `synthetic-${Math.floor(index / 40) % 2}`,
      );
      assert.equal(value.total_count, 100);
      latencies?.push(performance.now() - started);
    }
  };
  await run(160);
  bytes = charged = requests = parses = 0;
  gc.length = 0;
  JSON.parse = (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    parses++;
    return reviver ? parse(text, reviver) : parse(text);
  };
  if (allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const latencies: number[] = [];
  const hostLoad = loadavg();
  const cpu = process.cpuUsage();
  const started = performance.now();
  await run(iterations, latencies);
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const sampledBytes = allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, row) => sum + row.size,
        0,
      )
    : undefined;
  await new Promise<void>((done) => {
    setImmediate(done);
  });
  latencies.sort((a, b) => a - b);
  const memory = process.memoryUsage();
  observer.disconnect();
  let retainedHeapBytes: number | undefined;
  if (global.gc) {
    global.gc();
    retainedHeapBytes = process.memoryUsage().heapUsed;
  }
  console.log(
    JSON.stringify({
      modulePath,
      iterations,
      allocations,
      hostLoad,
      elapsedMs,
      requests,
      bytes,
      parses,
      charged,
      cpuUsPerPoll: (used.user + used.system) / iterations,
      sampledBytesPerPoll: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      p99Ms: latencies[Math.ceil(iterations * 0.99) - 1],
      gcMs: gc.reduce((sum, ms) => sum + ms, 0),
      maxGcMs: Math.max(0, ...gc),
      rssBytes: memory.rss,
      heapBytes: memory.heapUsed,
      retainedHeapBytes,
    }),
  );
} finally {
  JSON.parse = parse;
  observer.disconnect();
  inspector.disconnect();
  server.closeAllConnections();
  await new Promise<void>((done, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        done();
      }
    });
  });
}
