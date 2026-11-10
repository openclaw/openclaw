/**
 * Owner-only sidebar array encoding: 10k immutable rows, 1k-row pages, 66 retained viewers.
 * Transpile each revision's serialized-json.ts to ESM without bundling (TypeScript or esbuild),
 * preserve import specifiers, and record source hashes. Run five alternating A/B and B/A pairs:
 * node --expose-gc scripts/perf/session-array-encoding.ts \
 *   --owner-file .local/base-serialized-json.mjs --scenario delta --iterations 3000
 * Repeat with candidate ESM, and --scenario full for the full-send control. Without --owner-file,
 * run the repository source through node --expose-gc --import ./scripts/tsx.mjs instead.
 * Measure allocation separately with --allocations (includes collected objects).
 * Concurrent pairs: --barrier-dir <fresh-directory> --side base|candidate writes <side>.ready;
 * the controller waits for both ready files, then creates go in that directory.
 * Acceptance: lower delta-path allocation; no adverse full-send result with valid A/A controls.
 * Report absolute CPU/GC deltas and sample counts; sparse loop/GC tails are context only.
 * This does not measure Gateway authorization, selection, sockets, model turns or throughput.
 * Standalone source capsule: this file, serialized-json.ts, shared/owned-buffer.ts,
 * and packages/normalization-core/src/record-coerce.ts at their repository-relative paths.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate as yieldToLoop, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    scenario: { type: "string", default: "delta" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
    "barrier-dir": { type: "string" },
    side: { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
assert(values.scenario === "delta" || values.scenario === "full", "--scenario: delta or full");
assert(global.gc, "run with --expose-gc");
assert.equal(
  Boolean(values["barrier-dir"]),
  Boolean(values.side),
  "barrier-dir and side are paired",
);
assert(
  !values.side || values.side === "base" || values.side === "candidate",
  "--side: base or candidate",
);
const ownerUrl = new URL("../../src/gateway/serialized-json.ts", import.meta.url);
const source = readFileSync(values["owner-file"] ?? ownerUrl, "utf8");
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const target =
      specifier === "@openclaw/normalization-core/record-coerce"
        ? new URL("../../packages/normalization-core/src/record-coerce.ts", import.meta.url)
        : specifier === "../shared/owned-buffer.js"
          ? new URL("../../src/shared/owned-buffer.ts", import.meta.url)
          : undefined;
    return target ? { url: target.href, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    return url === ownerUrl.href && values["owner-file"]
      ? { format: "module", source, shortCircuit: true }
      : nextLoad(url, context);
  },
});
const owner: typeof import("../../src/gateway/serialized-json.js") = await import(ownerUrl.href);
hook.deregister();
const rows = Array.from({ length: 10_000 }, (_, index) =>
  Object.freeze({
    key: `agent:main:${index % 5 ? "subagent" : "dashboard"}:synthetic-${index}`,
    kind: "direct",
    sessionId: `synthetic-${index}`,
    updatedAt: 1_800_000_000_000 + index,
    label: `Synthetic session ${index}: review the workspace change 🦞`,
    rowMode: "sidebar",
    status: "done",
    archivedAt: 1_800_000_000_000,
    sharingRole: "viewer",
    sharedFacts: Object.freeze([0, 1]),
  }),
);
const encodings = new Map(rows.map((row) => [row, JSON.stringify(row)]));
const pageSize = 1_000;
const clients = 66;
const retained: (readonly (typeof rows)[number][])[] = [];
const order = Array.from({ length: pageSize }, (_, index) => (index === 999 ? 1000 : index));
const sharedFacts = [
  { visibility: "shared" },
  { sendDisabledReason: "session is shared for this connection" },
];
function prepare(index: number) {
  const slot = index % clients;
  const page = Object.freeze(rows.slice(slot * 100, slot * 100 + pageSize));
  owner.registerSerializedJsonArray(
    page,
    page.map((row) => encodings.get(row)!),
  );
  retained[slot] = page;
  const sessions =
    values.scenario === "full"
      ? page
      : owner.registerSerializedJsonArray([page[999]!], [encodings.get(page[999]!)!]);
  return {
    type: "res",
    id: "list",
    ok: true,
    payload: {
      sessions,
      sharedFacts,
      ...(values.scenario === "delta"
        ? { rowsDelta: { baseRevision: "synthetic-base", order } }
        : {}),
    },
  };
}
const golden = createHash("sha256");
const sizes: number[] = [];
for (let index = 0; index < clients; index++) {
  const frame = prepare(index);
  const encoded = owner.serializeGatewayFrame(frame).toString();
  assert.equal(encoded, JSON.stringify(frame));
  golden.update(encoded);
  sizes.push(Buffer.byteLength(encoded));
}
function send(index: number) {
  const encoded = owner.serializeGatewayFrame(prepare(index));
  // Production WebSocket transport can send the owned segments without flattening them.
  return typeof encoded === "string" ? Buffer.byteLength(encoded) : encoded.byteLength;
}
for (let index = 0; index < 200; index++) {
  send(index);
}
global.gc();
await yieldToLoop();
if (values["barrier-dir"]) {
  writeFileSync(path.join(values["barrier-dir"], `${values.side}.ready`), String(process.pid), {
    flag: "wx",
  });
  const deadline = Date.now() + 10 * 60_000;
  while (!existsSync(path.join(values["barrier-dir"], "go"))) {
    assert(Date.now() < deadline, "timed out waiting for paired measurement barrier");
    await delay(50);
  }
}
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16_384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const collections: { ms: number; kind: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    collections.push({
      ms: entry.duration,
      kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind,
    });
  }
});
observer.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
const memoryBefore = process.memoryUsage();
const loadBefore = loadavg();
const cpu = process.cpuUsage();
const thread = process.threadCpuUsage();
const start = performance.now();
let wireBytes = 0;
for (let index = 0; index < iterations; index++) {
  wireBytes += send(index);
  await yieldToLoop();
}
const elapsedMs = performance.now() - start;
const cpuUsed = process.cpuUsage(cpu);
const threadUsed = process.threadCpuUsage(thread);
const memoryAfter = process.memoryUsage();
const loadAfter = loadavg();
assert.equal(retained.length, clients);
loop.disable();
await yieldToLoop();
await yieldToLoop();
observer.disconnect();
let allocationBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocationBytes = sum(profile.head);
  inspector.disconnect();
}
assert.equal(
  wireBytes,
  Array.from({ length: iterations }, (_, i) => sizes[i % clients]!).reduce((a, b) => a + b, 0),
);
function distribution(samples: number[]) {
  samples.sort((a, b) => a - b);
  return {
    count: samples.length,
    totalMs: samples.reduce((sum, value) => sum + value, 0),
    maxMs: samples.at(-1) ?? 0,
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1] ?? null,
    p99Ms: samples[Math.ceil(samples.length * 0.99) - 1] ?? null,
  };
}
const gc = (kind?: number) =>
  distribution(
    collections
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map((entry) => entry.ms),
  );
console.log(
  JSON.stringify({
    node: process.version,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    scenario: values.scenario,
    mode: values.allocations ? "sampled-allocation" : "untraced-timing",
    iterations,
    roster: rows.length,
    pageSize,
    clients,
    wireBytes,
    wireHash: golden.digest("hex"),
    elapsedMs,
    mainCpuMs: (threadUsed.user + threadUsed.system) / 1000,
    processCpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    allocationBytes,
    allocationBytesPerOperation:
      allocationBytes === undefined ? undefined : allocationBytes / iterations,
    memoryBefore,
    memoryAfter,
    loadBefore,
    loadAfter,
    gc: {
      total: gc(),
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
    loop: {
      samples: loop.count,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
    },
  }),
);
