/**
 * Provider error owner probe; synthetic large 429/503 bodies and nested causes.
 * Bundle packages/ai/src/utils/provider-error.ts with esbuild (bundle/platform=node/format=esm)
 * on each revision, then run unchanged in counterbalanced base/candidate processes:
 * node --expose-gc scripts/perf/provider-error-projection-measure.mjs \
 *   --module .local/provider-error.mjs --status 429 --body json --mode timing --iterations 3000
 * --body object|json|oversized; --mode timing|allocation|survivors.
 * CPU is untraced. Allocation includes collected samples; survivors excludes them and
 * forces two minor GCs with the latest 64 results retained. For promoted bytes, add
 * --trace-gc-nvp only to a separate survivors pass and sum promoted= between markers.
 * Compare outputDigest across revisions. No provider requests or Gateway state are used.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    status: { type: "string", default: "429" },
    body: { type: "string", default: "json" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
  },
});
assert(values.module, "--module must select a bundled provider-error owner");
assert(globalThis.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
const status = Number(values.status);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(status === 429 || status === 503);
assert(["object", "json", "oversized"].includes(values.body));
assert(["timing", "allocation", "survivors"].includes(values.mode));
const { projectProviderError } = await import(pathToFileURL(resolve(values.module)).href);
const body = {
  error: {
    code: status === 429 ? "rate_limit_exceeded" : "overloaded",
    message: status === 429 ? "Synthetic rate limit reached" : "Synthetic service unavailable",
    details: Array.from({ length: 24 }, (_, index) => ({
      index,
      reason: "Synthetic diagnostic detail. ".repeat(10),
      metadata: { region: "synthetic", retryable: true },
    })),
  },
};
const serializedBody = JSON.stringify(body);
const fixture = {
  status,
  message: `${status} status code (no body)`,
  body:
    values.body === "object"
      ? body
      : values.body === "json"
        ? serializedBody
        : serializedBody.repeat(4),
  headers: new Headers({ "retry-after": "7", "x-request-id": "synthetic-request" }),
  cause: {
    message: "upstream",
    cause: { code: "ECONNRESET", cause: { message: "socket closed" } },
  },
};
const expected = projectProviderError(fixture);
assert.equal(expected.stopReason, "error");
assert.equal(expected.retryAfterMs, 7000);
assert(expected.errorMessage.includes(String(status)));
const outputDigest = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
const retained = Array.from({ length: 64 });
let checksum = 0;
function run(count) {
  for (let index = 0; index < count; index++) {
    const result = projectProviderError(fixture);
    retained[index % retained.length] = result;
    checksum += result.errorMessage.length;
  }
}
run(200);
globalThis.gc();
const inspector = new Session();
if (values.mode !== "timing") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: values.mode === "allocation",
    includeObjectsCollectedByMinorGC: values.mode === "allocation",
  });
}
const hostLoad = loadavg();
console.log("MEASURE_START");
const cpuStart = process.threadCpuUsage();
const wallStart = performance.now();
run(iterations);
const wallMs = performance.now() - wallStart;
const cpu = process.threadCpuUsage(cpuStart);
if (values.mode === "survivors") {
  globalThis.gc({ type: "minor", execution: "sync" });
  globalThis.gc({ type: "minor", execution: "sync" });
}
console.log("MEASURE_END");
let sampledBytes;
if (values.mode !== "timing") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
assert.equal(
  JSON.stringify(retained[(iterations - 1) % retained.length]),
  JSON.stringify(expected),
);
console.log(
  JSON.stringify({
    node: process.version,
    mode: values.mode,
    status,
    body: values.body,
    bodyBytes: Buffer.byteLength(
      values.body === "oversized" ? serializedBody.repeat(4) : serializedBody,
    ),
    iterations,
    cpuUsPerOp: (cpu.user + cpu.system) / iterations,
    wallUsPerOp: (wallMs * 1000) / iterations,
    sampledBytesPerOp: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    sampledBytes,
    retainedResults: retained.length,
    outputDigest,
    checksum,
    hostLoad,
    memory: process.memoryUsage(),
  }),
);
