// Owner microbench; does not measure Gateway/RPC or storage latency.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/core-quadratic-scans-measure.ts
//   --workload plugins|memory --mode timing|allocation --iterations 2000 [--owner saved-base.ts]
// Alternate base/candidate order. Memory uses 512 retained entries and 32 daily signals;
// only storage, workspace lock, file inspection, lineage, and host-event I/O are replaced.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { ShortTermRecallStore } from "../../extensions/memory-core/src/short-term-promotion-types.js";
import { createPluginManifestRecordFixture } from "../../src/plugins/plugin-metadata.test-support.js";

const { values } = parseArgs({
  options: {
    workload: { type: "string", default: "plugins" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    owner: { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(values.workload === "plugins" || values.workload === "memory");
assert(values.mode === "timing" || values.mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const ownerUrl = new URL(
  values.workload === "plugins"
    ? "../../src/config/channel-config-metadata.ts"
    : "../../extensions/memory-core/src/short-term-promotion-record.ts",
  import.meta.url,
);
const source = readFileSync(values.owner ?? ownerUrl, "utf8");
const ioUrl = `data:text/javascript,${encodeURIComponent(`
let initial, latest;
export function seedStore(value) { initial = value; }
export function readResult() { return latest; }
export async function readStore() { return { ...initial, entries: { ...initial.entries } }; }
export async function writeStore(value, store) { latest = store; }
export async function withMemoryWorkspaceLock(path, run) { return run(); }
export async function appendMemoryHostEvent() {}
export async function recordMemoryEntryOrigins() {}
export async function findForgottenMemorySessionIds() { return new Set(); }
export async function inspectWorkspaceFile() { throw new Error("Unexpected file inspection"); }
`)}`;
const ioImports = new Set([
  "./short-term-promotion-store.js",
  "./memory-workspace-lock.js",
  "./memory-workspace-files.js",
  "./memory-entry-origins.js",
  "openclaw/plugin-sdk/memory-host-events",
]);
let loaded = false;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === ownerUrl.href && ioImports.has(specifier)) {
      return { url: ioUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== ownerUrl.href) {
      return nextLoad(url, context);
    }
    loaded = true;
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});

let run: (count: number) => Promise<void>;
if (values.workload === "plugins") {
  const { collectPluginSchemaMetadataCore } =
    await import("../../src/config/channel-config-metadata.js");
  const registry = {
    diagnostics: [],
    plugins: Array.from({ length: 40 }, (_, index) =>
      createPluginManifestRecordFixture({
        id: `synthetic-${String(index).padStart(2, "0")}`,
        providerRequest: {
          providers: { [`provider-${index}`]: { family: "synthetic" } },
        },
      }),
    ),
  };
  run = async (count) => {
    let result;
    for (let index = 0; index < count; index++) {
      result = collectPluginSchemaMetadataCore(registry);
    }
    assert(result);
    assert.equal(result.length, 40);
    assert.equal(result[39]?.providerRequest?.providers?.["provider-39"]?.family, "synthetic");
  };
} else {
  const { recordShortTermRecalls } =
    await import("../../extensions/memory-core/src/short-term-promotion-record.js");
  const { buildClaimHash } =
    await import("../../extensions/memory-core/src/short-term-promotion-utils.js");
  const io: {
    seedStore: (store: ShortTermRecallStore) => void;
    readResult: () => ShortTermRecallStore;
  } = await import(ioUrl);
  const nowMs = Date.parse("2026-10-24T12:00:00.000Z");
  const nowIso = new Date(nowMs).toISOString();
  const snippet = (index: number) => `Synthetic maintenance fact number ${index}.`;
  const store: ShortTermRecallStore = {
    version: 1,
    updatedAt: nowIso,
    entries: Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => {
        const key = `memory:retained-${index}`;
        return [
          key,
          {
            key,
            path: "memory/2026-10-23.md",
            startLine: index + 1,
            endLine: index + 1,
            source: "memory",
            snippet: snippet(index),
            recallCount: 1,
            dailyCount: 0,
            groundedCount: 0,
            totalScore: 0.8,
            maxScore: 0.8,
            firstRecalledAt: nowIso,
            lastRecalledAt: nowIso,
            queryHashes: [],
            recallDays: [],
            conceptTags: [],
            claimHash: buildClaimHash(snippet(index)),
          },
        ];
      }),
    ),
  };
  io.seedStore(store);
  const input = {
    workspaceDir: "/synthetic/buf114",
    query: "Daily synthetic notes",
    signalType: "daily" as const,
    nowMs,
    timezone: "UTC",
    results: Array.from({ length: 32 }, (_, index) => ({
      path: "memory/2026-10-24.md",
      startLine: index + 1,
      endLine: index + 1,
      score: 0.8,
      source: "memory" as const,
      snippet: snippet(480 + index),
    })),
  };
  run = async (count) => {
    for (let index = 0; index < count; index++) {
      await recordShortTermRecalls(input);
    }
    const result = io.readResult();
    assert.equal(Object.keys(result.entries).length, 512);
    assert.equal(result.entries["memory:retained-511"]?.dailyCount, 1);
    assert.equal(result.entries["memory:retained-511"]?.path, "memory/2026-10-23.md");
  };
}
hooks.deregister();
assert(loaded, "The selected owner must be loaded");
await run(100);
global.gc();
await nextTurn();
const gcDurations: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcDurations.push(entry.duration);
  }
});
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
} else {
  observer.observe({ entryTypes: ["gc"] });
}
const hostLoad = loadavg();
const memoryBefore = process.memoryUsage();
const cpu = process.threadCpuUsage();
const start = performance.now();
await run(iterations);
const wallMs = performance.now() - start;
const used = process.threadCpuUsage(cpu);
const memoryAfter = process.memoryUsage();
await nextTurn();
await nextTurn();
observer.disconnect();
let allocatedBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    workload: values.workload,
    mode: values.mode,
    ownerSha256: createHash("sha256").update(source).digest("hex"),
    iterations,
    plugins: values.workload === "plugins" ? 40 : undefined,
    retainedEntries: values.workload === "memory" ? 512 : undefined,
    signalsPerCall: values.workload === "memory" ? 32 : undefined,
    hostLoad,
    node: process.version,
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    bytesPerCall: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    gc: {
      count: gcDurations.length,
      totalMs: gcDurations.reduce((total, duration) => total + duration, 0),
      maxMs: Math.max(0, ...gcDurations),
    },
    memoryBefore,
    memoryAfter,
  }),
);
