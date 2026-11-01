/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/current-work-refetch-measure.ts
 * Run unchanged on base and candidate. Measures 3,000 certified-event/fallback
 * windows through the production Current Work owner with 21 active sessions.
 * Node's clock advances 65 seconds per window; this is NOT a live load test.
 * The RPC boundary returns fresh decoded rows, excluding server query/transport
 * costs. Five untraced CPU passes and one separate inclusive allocation pass.
 * Acceptance: fewer list RPCs, final row facts identical, no material CPU or
 * allocation increase. History's aggregate fallback is covered by focused tests.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { GatewayBrowserClient } from "../../ui/src/api/gateway.ts";
import type { GatewaySessionRow } from "../../ui/src/api/types.ts";
import { createSessionActivity } from "../../ui/src/pages/activity/session-activity-owner.ts";

const iterations = 3_000;
const activeSessions = 21;
const gc = global.gc;
assert(gc, "Run with --expose-gc");

async function run() {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const rows: GatewaySessionRow[] = Array.from({ length: activeSessions }, (_, i) => ({
    key: `agent:main:synthetic-${i}`,
    agentId: "main",
    sessionId: `synthetic-${i}`,
    kind: "direct",
    updatedAt: Date.now(),
    snapshotAt: Date.now(),
    status: "running",
    hasActiveRun: true,
    activeRunIds: [`run-${i}`],
  }));
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  let calls = 0;
  Object.defineProperty(client, "request", {
    value: async () => {
      calls++;
      return {
        ts: Date.now(),
        path: "",
        count: rows.length,
        totalCount: rows.length,
        hasMore: false,
        limitApplied: 100,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: structuredClone(rows),
      };
    },
  });
  const owner = createSessionActivity(() => {});
  try {
    await owner.load(client, "current");
    for (let i = 0; i < iterations; i++) {
      const row = rows[i % rows.length]!;
      Object.assign(row, {
        updatedAt: Date.now() + 1,
        snapshotAt: Date.now() + 1,
        label: `Synthetic revision ${i}`,
      });
      owner.invalidate({ agentId: "main", reason: "patch", session: row, ancestorSessions: [] });
      mock.timers.tick(60_000);
      mock.timers.tick(5_000);
      await setImmediate();
    }
    const facts = (list: readonly GatewaySessionRow[]) =>
      list
        .map(({ key, label, updatedAt }) => ({ key, label, updatedAt }))
        .toSorted((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(facts(owner.result?.sessions ?? []), facts(rows));
    assert.equal(owner.incomplete, false);
    return { listCalls: calls, finalRows: owner.result?.sessions.length };
  } finally {
    owner.dispose();
    mock.timers.reset();
  }
}

await run();
const timing = [];
for (let pass = 0; pass < 5; pass++) {
  gc();
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  const counts = await run();
  const used = process.threadCpuUsage(cpu);
  timing.push({
    ...counts,
    cpuMs: (used.user + used.system) / 1_000,
    wallMs: performance.now() - start,
    hostLoad,
  });
}
gc();
const inspector = new Session();
inspector.connect();
try {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const counts = await run();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  console.log(
    JSON.stringify(
      {
        node: process.version,
        iterations,
        activeSessions,
        timing,
        allocation: {
          ...counts,
          sampledBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
        },
      },
      null,
      2,
    ),
  );
} finally {
  inspector.disconnect();
}
