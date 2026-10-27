/**
 * Artifact-list payload selection owner benchmark (synthetic, no Gateway/state).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/artifacts-block-measure.ts \
 *   --iterations 3000 --mode timing [--baseline-dir /absolute/source-overlay]
 * Repeat with --mode allocation; alternate baseline/candidate processes. An overlay
 * holds only src/gateway/artifacts-content.ts from the baseline; unchanged dependencies
 * remain in this checkout. Each list contains 64 artifacts with 16-KiB payload aliases,
 * including data-URL precedence, direct data, invalid-first fallback, and URL-only data.
 * Acceptance: identical response hash, less CPU/allocation, no material latency rise.
 * Sampling includes collected objects; only the untraced pass supplies timing evidence.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "3000" },
    mode: { type: "string", default: "timing" },
    "baseline-dir": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations >= 1000);
assert(values.mode === "timing" || values.mode === "allocation");
assert(globalThis.gc, "Run with --expose-gc");
const ownerPath = "src/gateway/artifacts-content.ts";
const source = values["baseline-dir"]
  ? path.resolve(values["baseline-dir"], ownerPath)
  : fileURLToPath(new URL(`../../${ownerPath}`, import.meta.url));
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const { selectSessionArtifacts } = await import("../../src/gateway/session-artifact-read.js");
const payload = Buffer.alloc(12 * 1024, 97).toString("base64");
const blocks = [
  {
    url: `data:text/plain;base64,${payload}`,
    data: payload,
    source: { data: payload },
    content: payload,
  },
  { data: payload, source: { data: payload }, content: payload },
  { data: "invalid!", source: { data: payload }, content: payload },
  { url: "https://example.test/synthetic.txt" },
];
const messages = Array.from({ length: 64 }, (_, index) => ({
  role: "assistant",
  content: [{ type: "file", title: `synthetic-${index}.txt`, ...blocks[index % blocks.length] }],
}));
const scope = {
  agentId: "main",
  sessionKey: "agent:main:synthetic",
  sessionId: "synthetic",
  storePath: "/synthetic-unused",
};
const read = () =>
  selectSessionArtifacts(
    scope,
    { kind: "list", sessionKey: scope.sessionKey, includeDownloadData: false },
    {
      visitSessionMessagesAsync: async (_scope, visit) => {
        messages.forEach((message, index) => visit(message, index + 1));
        return messages.length;
      },
      readSessionMessagesPageWithStatsAsync: async () => {
        throw new Error("List must not use image pagination");
      },
    },
  );
const response = await read();
assert(response.kind === "list");
assert.equal(response.artifacts.length, messages.length);
for (const [index, artifact] of response.artifacts.entries()) {
  assert.equal(artifact.title, `synthetic-${index}.txt`);
  assert.equal(artifact.download.mode, index % 4 === 3 ? "url" : "bytes");
  assert.equal(artifact.sizeBytes, index % 4 === 3 ? undefined : 12 * 1024);
  assert.equal(artifact.data, undefined);
}
for (let index = 0; index < 100; index++) {
  await read();
}
globalThis.gc();
const inspector = values.mode === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const samples = new Float64Array(iterations);
const hostLoadBefore = loadavg();
const cpu = process.threadCpuUsage();
for (let index = 0; index < iterations; index++) {
  const started = performance.now();
  await read();
  samples[index] = performance.now() - started;
}
const used = process.threadCpuUsage(cpu);
let allocatedBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const sum = (node: typeof profile.head): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
}
samples.sort();
console.log(
  JSON.stringify({
    mode: values.mode,
    iterations,
    artifactsPerList: messages.length,
    sourceDigest: createHash("sha256").update(readFileSync(source)).digest("hex"),
    responseDigest: createHash("sha256").update(JSON.stringify(response)).digest("hex"),
    cpuUsPerList: (used.user + used.system) / iterations,
    allocatedBytesPerList: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    p50Ms: samples[Math.floor(iterations * 0.5)],
    p99Ms: samples[Math.floor(iterations * 0.99)],
    memory: process.memoryUsage(),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    node: process.version,
  }),
);
