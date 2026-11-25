/**
 * Encoded model body handoff through the real fetch guard and native Request extraction.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/model-request-body-measure.ts
 *   --base HEAD --iterations 500 --pairs 5 [--allocation]
 * A/A/B arms reuse worker-shaped, owned 600 KiB UTF-8 bytes. Encoding and network
 * latency are excluded; each dispatch consumes native Fetch's body snapshot.
 * Acceptance: identical wire bytes, lower CPU and allocation, no material GC regression.
 * Sampled JS allocation excludes native backing stores; count eliminated native copies separately.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { hash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import * as candidate from "../../packages/ai/src/transports/model-request-body.js";
import { fetchWithSsrFGuard } from "../../src/infra/net/fetch-guard.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "HEAD" },
    iterations: { type: "string", default: "500" },
    pairs: { type: "string", default: "5" },
    allocation: { type: "boolean", default: false },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 500,
  min: 1,
  label: "iterations",
});
const pairs = parseStrictIntegerOption({ raw: values.pairs, fallback: 5, min: 1, label: "pairs" });
assert(globalThis.gc, "run with --expose-gc");
const scratch = await mkdtemp(path.join(tmpdir(), "model-request-body-measure-"));
const owner = "packages/ai/src/transports/model-request-body.ts";
const source = execFileSync("git", ["show", `${values.base}:${owner}`], { encoding: "utf8" });
await writeFile(path.join(scratch, "baseline.ts"), source);
const baseline: typeof candidate = await import(
  pathToFileURL(path.join(scratch, "baseline.ts")).href
);
const payload = { stream: true, input: "Synthetic UTF-8 🦞 café ".repeat(22000) };
let wire = JSON.stringify(payload);
payload.input += "x".repeat(Math.max(0, 614400 - Buffer.byteLength(wire)));
wire = JSON.stringify(payload);
const bytes = new TextEncoder().encode(wire);
const wireSha256 = hash("sha256", bytes);
let last: ArrayBuffer | undefined;
const fetchImpl: typeof fetch = async (input, init) => {
  last = await new Request(input, init).arrayBuffer();
  return new Response(null, { status: 200 });
};
async function arm(module: typeof candidate, label: string, pair: number) {
  const options = {};
  module.modelRequestBodyState(options).encode = async () => ({ body: bytes, stream: true });
  const encode = module.prepareModelRequestBody(options);
  const run = async (count: number) => {
    for (let i = 0; i < count; i++) {
      const prepared = await encode(payload);
      const result = await fetchWithSsrFGuard({
        url: "https://public.example/start",
        capture: false,
        fetchImpl,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        init: { method: "POST", ...prepared },
      });
      await result.release();
    }
  };
  await run(100);
  assert.equal(hash("sha256", new Uint8Array(last!)), wireSha256);
  globalThis.gc!();
  const inspector = new Session();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const gc = new GCProfiler();
  gc.start();
  const hostLoad = loadavg(),
    cpu = process.threadCpuUsage(),
    start = performance.now();
  await run(iterations);
  const wallUs = ((performance.now() - start) * 1000) / iterations;
  const used = process.threadCpuUsage(cpu);
  const gcMs = (gc.stop()?.statistics ?? []).reduce((sum, entry) => sum + entry.cost / 1000, 0);
  let allocationBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocationBytes = sum(profile.head) / iterations;
    inspector.disconnect();
  }
  assert.equal(hash("sha256", new Uint8Array(last!)), wireSha256);
  console.log(
    JSON.stringify({
      label,
      pair,
      iterations,
      allocation: values.allocation,
      wireBytes: bytes.byteLength,
      wireSha256,
      cpuUs: (used.user + used.system) / iterations,
      wallUs,
      allocationBytes,
      gcMs,
      hostLoad,
    }),
  );
}
try {
  for (let pair = 0; pair < pairs; pair++) {
    await arm(baseline, "A", pair);
    await arm(baseline, "A-control", pair);
    await arm(candidate, "B", pair);
  }
} finally {
  await rm(scratch, { recursive: true });
}
