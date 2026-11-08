/**
 * Cold-navigation owner probe: compare the same query with and without the
 * lifecycle-owned native statement cache. Synthetic 12 KB assistant/tool events;
 * alternating AB/BA pairs, fresh connection per arm, two warmup events per arm.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/cold-navigation-projection.mjs \
 *   --mode timing --iterations 1000 --pairs 5
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cold-navigation-projection.mjs \
 *   --mode allocation --iterations 500 --pairs 5
 *
 * Timing is untraced. Allocation uses a separate 32 KiB sampling pass including
 * collected objects. Output is JSON; navigation bytes must agree across arms.
 * This isolates statement preparation and does not replace the Doctor fixture run.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { projectSessionTranscriptReportFacts } from "../../src/config/sessions/session-transcript-report-facts.ts";
import { readTranscriptPayloadNavigation } from "../../src/config/sessions/transcript-payload-navigation.ts";
import { enableNodeSqliteKyselyStatementCache } from "../../src/infra/kysely-sync-cache-state.ts";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.ts";

const { values: options } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "1000" },
    pairs: { type: "string", default: "5" },
  },
});
const iterations = Number(options.iterations);
const pairs = Number(options.pairs);
assert(Number.isSafeInteger(iterations) && iterations > 0, "Invalid --iterations");
assert(Number.isSafeInteger(pairs) && pairs > 0, "Invalid --pairs");
assert(["timing", "allocation"].includes(options.mode), "Invalid --mode");
if (options.mode === "allocation") {
  assert(globalThis.gc, "Allocation mode requires --expose-gc");
}
const fixtures = [
  {
    type: "message",
    id: "test",
    parentId: null,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "synthetic ".repeat(1200) },
        { type: "toolCall", id: "call", name: "exec", arguments: { command: "echo synthetic" } },
      ],
    },
  },
  {
    type: "message",
    id: "test",
    parentId: null,
    message: {
      role: "toolResult",
      toolCallId: "call",
      content: [{ type: "text", text: "synthetic ".repeat(1200) }],
      details: { private: "test" },
      __openclaw: { runId: "run", steerTargetRunId: "steer" },
    },
  },
].map((event) => ({
  event: JSON.stringify(event),
  report: JSON.stringify(projectSessionTranscriptReportFacts(event)),
}));
const inspector = new Session();
inspector.connect();
const expected = new Map();
const results = [];
try {
  for (let pair = 0; pair < pairs; pair++) {
    for (const cached of pair % 2 ? [true, false] : [false, true]) {
      const db = openNodeSqliteDatabase(":memory:");
      try {
        if (cached) {
          enableNodeSqliteKyselyStatementCache(db);
        }
        const prepare = db.prepare.bind(db);
        let prepareCount = 0;
        let prepareMs = 0;
        db.prepare = (...args) => {
          prepareCount++;
          const start = performance.now();
          try {
            return prepare(...args);
          } finally {
            prepareMs += performance.now() - start;
          }
        };
        for (const fixture of fixtures) {
          const navigation = readTranscriptPayloadNavigation(db, fixture.event, fixture.report);
          assert.notEqual(navigation, null);
          if (expected.has(fixture.event)) {
            assert.equal(navigation, expected.get(fixture.event));
          } else {
            expected.set(fixture.event, navigation);
          }
        }
        if (options.mode === "allocation") {
          globalThis.gc();
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        prepareCount = 0;
        prepareMs = 0;
        const hostLoad = loadavg();
        const started = performance.now();
        const cpu = process.threadCpuUsage();
        for (let index = 0; index < iterations; index++) {
          const fixture = fixtures[index % fixtures.length];
          readTranscriptPayloadNavigation(db, fixture.event, fixture.report);
        }
        const cpuUsed = process.threadCpuUsage(cpu);
        const elapsedMs = performance.now() - started;
        let allocationBytes;
        if (options.mode === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          allocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
        }
        results.push({
          pair,
          cached,
          iterations,
          elapsedMs,
          cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
          allocationBytes,
          prepareCount,
          prepareMs,
          hostLoad,
        });
      } finally {
        db.close();
      }
    }
  }
} finally {
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode: options.mode,
    node: process.version,
    bytes: fixtures.map((fixture) => Buffer.byteLength(fixture.event)),
    results,
  }),
);
