// Real catalog reconciliation and filesystem scanner; synthetic native catalog rows.
// Prepare once with --state-dir <isolated-dir> --prepare, then measure with
// --state-dir <isolated-dir> --operations 2000 --output <result.json>.
// Use --owner <captured-owner.ts> for a baseline, keeping its dependency runtime
// identical. Alternate baseline/candidate order for five pairs; collect CPU/GC
// without instrumentation and allocation separately with --allocations.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CodexCatalogIndexRow } from "../../extensions/codex/src/session-catalog-index-row.js";
import { CodexCatalogRolloutScanner } from "../../extensions/codex/src/session-catalog-rollout-scanner.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    owner: { type: "string" },
    output: { type: "string" },
    prepare: { type: "boolean" },
    operations: { type: "string", default: "5000" },
    warmup: { type: "string", default: "100" },
    "start-at": { type: "string", default: "0" },
    "gc-log": { type: "string" },
    allocations: { type: "boolean" },
    "count-path-work": { type: "boolean" },
  },
});
assert(values["state-dir"], "Pass an isolated --state-dir, prepared with --prepare");
const stateDir = path.resolve(values["state-dir"]);
const root = path.join(stateDir, "sessions");
const sessionCount = 5000;
const number = (name: "operations" | "warmup" | "start-at", min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const operations = number("operations", 1);
const warmup = number("warmup", 1);
const startAt = number("start-at", 0);
if (values.prepare) {
  await mkdir(stateDir);
  const leaf = path.join(root, "2026", "01", "01");
  await mkdir(leaf, { recursive: true });
  for (let i = 0; i < sessionCount; i++) {
    await writeFile(
      path.join(leaf, `rollout-${i}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: `synthetic-${i}`, timestamp: "2026-01-01T00:00:00Z", source: "cli" } })}\n`,
    );
  }
  console.log(JSON.stringify({ prepared: stateDir, sessionCount }));
  process.exit(0);
}
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL("../../extensions/codex/src/session-catalog-index-files.ts", import.meta.url);
const {
  reconcileCodexCatalogFiles,
}: typeof import("../../extensions/codex/src/session-catalog-index-files.js") = await import(
  ownerUrl.href
);
const scanner = new CodexCatalogRolloutScanner(root);
const rows = new Map<string, CodexCatalogIndexRow>();
const files = (await scanner.scan(new Set())).files;
assert.equal(files.size, sessionCount);
for (const [rolloutPath, fingerprint] of files) {
  rows.set(rolloutPath, {
    threadId: rolloutPath,
    rolloutPath,
    fingerprint,
    archived: false,
    nativeMetadata: true,
    updatedAt: 1,
    recencyAt: 1,
    page: { sessions: [] },
  });
}
const unexpected = (): never => {
  throw new Error("Unchanged catalog reconciliation attempted a publication or native refresh");
};
const owner = {
  rows,
  observedFiles: files,
  scanner,
  assertCurrent() {},
  requestNativeRefresh: unexpected,
  report: unexpected,
  put: unexpected,
  remove: unexpected,
};
const run = async () => {
  owner.observedFiles = await reconcileCodexCatalogFiles(root, owner);
  assert.equal(owner.observedFiles.size, sessionCount);
};
const profilePath = path.join(stateDir, "allocation.heapprofile");
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
if (values["gc-log"]) {
  assert(global.gc, "Tracing requires --expose-gc for isolate identification before warmup");
  marker("identify-start");
  global.gc();
  marker("identify-stop");
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, ms) => sum + ms, 0);
  return {
    count,
    totalMs,
    meanMs: count ? totalMs / count : 0,
    maxMs: sorted.at(-1) ?? 0,
    p50Ms: sorted[Math.ceil(count * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(count * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(count * 0.99) - 1] ?? null,
  };
}
const collections: { kind: number; ms: number }[] = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;
const observer = new PerformanceObserver((list) =>
  recordGcCollections(list.getEntries(), collections, measuredStart, measuredEnd),
);
const loop = monitorEventLoopDelay({ resolution: 1 });
const inspector = new Session();
const originalRelative = path.relative;
let coverageChecks = 0;
try {
  for (let i = 0; i < warmup; i++) {
    await run();
  }
  if (values["count-path-work"]) {
    path.relative = (from, to) => {
      if (from === root) {
        coverageChecks++;
      }
      return originalRelative(from, to);
    };
  }
  if (values.allocations) {
    inspector.connect();
  }
  loop.enable();
  await delay(10);
  writeSync(
    1,
    `CATALOG_READY ${JSON.stringify({ pid: process.pid, startAt, processAgeMs: performance.now() })}\n`,
  );
  if (startAt) {
    assert(Date.now() < startAt, "Missed synchronized start after warmup");
    await delay(startAt - Date.now());
  }
  observer.observe({ entryTypes: ["gc"] });
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.cpuUsage();
  const hostLoadStart = loadavg();
  const memoryStart = process.memoryUsage();
  const latencies: number[] = [];
  loop.reset();
  marker("heap-start");
  const actualStartAt = Date.now();
  measuredStart = performance.now();
  for (let i = 0; i < operations; i++) {
    const start = performance.now();
    await run();
    latencies.push(performance.now() - start);
  }
  measuredEnd = performance.now();
  marker("heap-stop");
  const usedCpu = process.cpuUsage(cpu);
  loop.disable();
  await nextTurn();
  recordGcCollections(observer.takeRecords(), collections, measuredStart, measuredEnd);
  observer.disconnect();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  let allocatedBytes = 0;
  let coverageBytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, covered = false) => {
    const inCoverage =
      covered || node.callFrame.functionName === "isCodexCatalogRolloutPathCovered";
    allocatedBytes += node.selfSize;
    if (inCoverage) {
      coverageBytes += node.selfSize;
    }
    node.children.forEach((child) => visit(child, inCoverage));
  };
  if (profile) {
    visit(profile.head);
    await writeFile(profilePath, JSON.stringify(profile));
  }
  const gc = (kind?: number) =>
    distribution(
      collections
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map((entry) => entry.ms),
    );
  const total = gc();
  const promotion = values["gc-log"]
    ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
    : undefined;
  const report = {
    scope:
      "Real file reconciliation owner and filesystem scanner over prepared unchanged rollout files; no Gateway/native App Server latency claim",
    node: process.version,
    owner: ownerUrl.href,
    sessionCount,
    operations,
    warmup,
    startAt,
    actualStartAt,
    processAgeAtStartMs: measuredStart,
    elapsedMs: measuredEnd - measuredStart,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    hostLoad: { start: hostLoadStart, end: loadavg() },
    memory: { start: memoryStart, end: process.memoryUsage() },
    verifiedRows: sessionCount * operations,
    coverageChecks: values["count-path-work"] ? coverageChecks : null,
    latency: distribution(latencies),
    gc: {
      total,
      msPerReconcile: total.totalMs / operations,
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
      incremental: gc(constants.NODE_PERFORMANCE_GC_INCREMENTAL),
      weak: gc(constants.NODE_PERFORMANCE_GC_WEAKCB),
    },
    eventLoop: {
      count: loop.count,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
    },
    promotion: promotion
      ? { ...promotion, bytesPerReconcile: promotion.promotedBytes / operations }
      : null,
    allocation: profile
      ? {
          allocatedBytes,
          bytesPerReconcile: allocatedBytes / operations,
          coverageBytes,
          coverageBytesPerReconcile: coverageBytes / operations,
        }
      : null,
  };
  await writeFile(
    values.output ?? path.join(stateDir, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
} finally {
  path.relative = originalRelative;
  scanner.close();
  observer.disconnect();
  loop.disable();
  if (values.allocations) {
    inspector.disconnect();
  }
}
