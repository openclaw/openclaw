/**
 * Sidebar fact-packing owner benchmark: 10k immutable rows, 500-row refreshed pages,
 * 66 interleaved page slots, one replacement row per page. No Gateway/RPC latency claim.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sidebar-fact-sharing-measure.ts \
 *   --owner-file .local/buf268/base.ts --output .local/buf268/base.json --iterations 3000
 * Alternate base/candidate order for five pairs. Run separate --allocations passes
 * (sampled V8 allocation includes collected objects); timing/GC uses untraced passes.
 * Compare packedDigest across revisions: it covers exact sessions/sharedFacts JSON,
 * including property order, but excludes random rowsRevision tokens. Expansion is
 * independently checked against the input pages before measurement.
 * Acceptance: lower allocation or CPU, unchanged bytes, no material controlled harm.
 * Run matched A/A controls before interpreting adverse timing/GC. Sparse tails are context.
 * Add --cold to replace every row identity (includes shallow fixture copying/freezing).
 * --max-owner-bytes-per-call <bytes> adds an opt-in sampled allocation regression
 * budget; it requires --allocations and is never an ordinary-CI timing threshold.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { expandSessionRowFacts } from "../../packages/gateway-protocol/src/session-row-fields.js";
import type { GatewaySessionRow } from "../../src/gateway/session-utils.types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
    cold: { type: "boolean", default: false },
    "max-owner-bytes-per-call": { type: "string" },
  },
});
assert(values.output, "--output is required");
assert(global.gc, "run with --expose-gc");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
const allocationBudget =
  values["max-owner-bytes-per-call"] === undefined
    ? undefined
    : Number(values["max-owner-bytes-per-call"]);
assert(
  allocationBudget === undefined ||
    (values.allocations && Number.isFinite(allocationBudget) && allocationBudget > 0),
  "--max-owner-bytes-per-call requires --allocations and a positive byte budget",
);
const output = path.resolve(values.output);
const root = `${output}.state`;
mkdirSync(root, { recursive: true });
const configPath = path.join(root, "openclaw.json");
writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
process.env = createGatewayBenchEnv(root, configPath, {
  startupTrace: false,
  caseEnv: { TMPDIR: root },
});
const ownerFile = values["owner-file"] ?? "src/gateway/session-row-presentation.ts";
const ownerSource = readFileSync(ownerFile, "utf8");
let replaced = false;
const hook = registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url.endsWith("/src/gateway/session-row-presentation.ts")) {
      replaced = true;
      return { ...loaded, source: stripTypeScriptTypes(ownerSource) };
    }
    return loaded;
  },
});
const { shareSidebarSessionRows } = await import("../../src/gateway/session-row-presentation.js");
hook.deregister();
assert(replaced, "owner substitution did not run");

const rowCount = 10_000;
const pageSize = 500;
const slots = 66;
const rows: GatewaySessionRow[] = Array.from({ length: rowCount }, (_, index) =>
  Object.freeze({
    key: `agent:main:${index % 5 ? "subagent" : "dashboard"}:synthetic-${index}`,
    kind: "direct",
    sessionId: `synthetic-${index}`,
    updatedAt: 1_800_000_000_000 + index,
    rowMode: "sidebar",
    label: `Synthetic session ${index}: review the workspace change 🦞`,
    status: "done",
    archived: index % 5 === 0,
    pinned: false,
    visibility: "shared",
    sharingRole: "viewer",
    sendDisabledReason: "session is shared for this connection",
    origin: Object.freeze({ provider: "synthetic", accountId: `account-${index % 4}` }),
    hasActiveRun: false,
    hasActiveSubagentRun: false,
    childOwnerSessionKeys: [],
  }),
);
const replacements = rows.map((row) => Object.freeze({ ...row, updatedAt: row.updatedAt! + 1 }));
function page(index: number) {
  const slot = index % slots;
  const start = slot * 137;
  const result = rows.slice(start, start + pageSize);
  const changed = Math.floor(index / slots) % pageSize;
  result[changed] = replacements[start + changed]!;
  return values.cold ? result.map((row) => Object.freeze({ ...row })) : result;
}
const retained: ReturnType<typeof shareSidebarSessionRows>[] = [];
function run(index: number) {
  const result = shareSidebarSessionRows(page(index));
  retained[index % slots] = result;
  return result;
}
const golden = createHash("sha256");
for (let index = 0; index < slots * 2; index++) {
  const input = page(index);
  const result = shareSidebarSessionRows(input);
  assert.deepEqual(expandSessionRowFacts(result.sessions, result.sharedFacts), input);
  golden.update(JSON.stringify({ sessions: result.sessions, sharedFacts: result.sharedFacts }));
}
for (let index = 0; index < 1000; index++) {
  run(index);
}
global.gc();
await nextTurn();
const collections: { kind: number; ms: number }[] = [];
let start = Infinity;
let end = Infinity;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime >= start && entry.startTime <= end) {
      collections.push({
        kind: (entry as typeof entry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  }
});
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const loop = monitorEventLoopDelay({ resolution: 1 });
observer.observe({ entryTypes: ["gc"] });
loop.enable();
const loadStart = loadavg();
const memoryStart = process.memoryUsage();
const cpuStart = process.threadCpuUsage();
const latency: number[] = [];
start = performance.now();
for (let index = 0; index < iterations; index++) {
  const at = performance.now();
  run(index);
  latency.push(performance.now() - at);
  await nextTurn();
}
end = performance.now();
const cpu = process.threadCpuUsage(cpuStart);
const memoryEnd = process.memoryUsage();
loop.disable();
await nextTurn();
observer.disconnect();
let allocation: { totalBytes: number; ownerBytes: number } | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  writeFileSync(`${output}.heapprofile`, JSON.stringify(profile));
  allocation = { totalBytes: 0, ownerBytes: 0 };
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, owner = false) => {
    const active = owner || node.callFrame.url.includes("session-row-presentation");
    allocation!.totalBytes += node.selfSize;
    if (active) {
      allocation!.ownerBytes += node.selfSize;
    }
    for (const child of node.children) {
      visit(child, active);
    }
  };
  visit(profile.head);
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    totalMs: sorted.reduce((a, b) => a + b, 0),
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}
const gc = (kind?: number) =>
  distribution(
    collections
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map((entry) => entry.ms),
  );
const result = {
  scope: "Sidebar fact sharing only; no Gateway, selection, authorization, RPC, or model turns",
  node: process.version,
  sourceHash: createHash("sha256").update(ownerSource).digest("hex"),
  mode: values.allocations ? "sampled-allocation" : "untraced-timing",
  scenario: values.cold ? "cold-identities" : "warm-identities",
  rowCount,
  pageSize,
  slots,
  iterations,
  packedDigest: golden.digest("hex"),
  elapsedMs: end - start,
  mainCpuMsPerCall: (cpu.user + cpu.system) / 1000 / iterations,
  allocation,
  latency: distribution(latency),
  gc: {
    total: gc(),
    minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
    major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
  },
  loop: { samples: loop.count, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 },
  loadStart,
  loadEnd: loadavg(),
  memoryStart,
  memoryEnd,
  retainedLists: retained.length,
};
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
if (allocationBudget !== undefined) {
  assert(
    allocation!.ownerBytes / iterations <= allocationBudget,
    `Owner allocation ${allocation!.ownerBytes / iterations} B/call exceeds ${allocationBudget}`,
  );
}
