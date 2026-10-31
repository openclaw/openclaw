/**
 * Synthetic native hydration owner proof (no Gateway or native process).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-catalog-hydrate-measure.ts
 * Use --sample for a separate allocation pass. Run five alternating base/candidate
 * samples of each mode on identical source fixtures. Default: 10k resident rows,
 * 40 full safety walks (25,000 native pages); one percent changes per walk.
 * Date.now advances only to trigger the owner's existing demand-driven safety walk.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { CodexCatalogIndexRow } from "../../extensions/codex/src/session-catalog-index-row.js";
import { CodexCatalogIndex } from "../../extensions/codex/src/session-catalog-index.js";

const { values } = parseArgs({
  options: {
    sample: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "codex-hydration-"));
const walks = 40;
const rows = Array.from({ length: 10_000 }, (_, i): CodexCatalogIndexRow => ({
  threadId: `synthetic-${i}`,
  updatedAt: 10_000 - i,
  recencyAt: 10_000 - i,
  archived: false,
  nativeMetadata: true,
  preview: `Synthetic request ${i}`,
  page: {
    sessions: [
      {
        threadId: `synthetic-${i}`,
        name: i % 2 ? `Synthetic title ${i}` : null,
        ...(i % 2 ? {} : { fallbackName: `Synthetic request ${i}` }),
        cwd: `/synthetic/project-${i % 40}`,
        status: i % 100 ? "notLoaded" : "active",
        ...(i % 100 ? {} : { activeFlags: ["waitingOnApproval"] }),
        archived: false,
      },
    ],
  },
}));
let reads = 0;
const nativeWalks: Promise<unknown>[] = [];
const index = new CodexCatalogIndex({
  homeId: "synthetic-hydration-measure",
  ...(!values.remote ? { localSessionsRoot: root } : {}),
  assertCurrent() {},
  readNative: async (params) => {
    reads++;
    const offset = Number(params.cursor ?? 0);
    const end = offset + (params.limit ?? 16);
    return {
      rows: rows.slice(offset, end),
      ...(end < rows.length ? { nextCursor: String(end) } : {}),
    };
  },
  runNativeWalk: (run) => {
    const result = run();
    nativeWalks.push(result);
    return result;
  },
});
const originalNow = Date.now;
let now = originalNow();
Date.now = () => now;
const inspector = values.sample ? new Session() : undefined;
const pauses: number[] = [];
const observer = new PerformanceObserver((list) =>
  pauses.push(...list.getEntries().map((e) => e.duration)),
);
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
try {
  await index.initialize();
  await index.reconcile();
  assert.equal(reads, 625);
  reads = 0;
  nativeWalks.length = 0;
  global.gc?.();
  await nextTurn();
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoadBefore = loadavg();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let walk = 0; walk < walks; walk++) {
    // Metadata edits deliberately keep activity timestamps unchanged.
    for (let i = 0; i < rows.length; i += 100) {
      const row = rows[i]!;
      rows[i] = {
        ...row,
        page: { sessions: [{ ...row.page.sessions[0]!, name: `Changed title ${walk}:${i}` }] },
      };
    }
    now += 15 * 60_000 + 1;
    await index.list({ limit: 16 });
    await nextTurn();
    assert.equal(nativeWalks.length, 1);
    const pending = nativeWalks.pop();
    assert(pending, "Resident demand must start a full native safety walk");
    await pending;
    await nextTurn();
    assert.equal(index.get("synthetic-0")?.page.sessions[0]?.name, `Changed title ${walk}:0`);
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  await nextTurn();
  pauses.push(...observer.takeRecords().map((e) => e.duration));
  observer.disconnect();
  const allocationBytes = inspector
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  assert.equal(reads, 625 * walks);
  console.log(
    JSON.stringify({
      mode: values.sample ? "allocation" : "timing",
      local: !values.remote,
      rows: rows.length,
      walks,
      pages: reads,
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      allocationBytes,
      gcMs: pauses.reduce((sum, value) => sum + value, 0),
      gcCount: pauses.length,
      maxGcMs: Math.max(0, ...pauses),
      memory: process.memoryUsage(),
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    }),
  );
} finally {
  Date.now = originalNow;
  observer.disconnect();
  inspector?.disconnect();
  await index.close();
  await rm(root, { recursive: true, force: true });
}
