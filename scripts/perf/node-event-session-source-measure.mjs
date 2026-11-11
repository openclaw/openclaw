/**
 * Measure session-source preparation plus the consuming node event's JSON decode.
 * Run on each revision with the same script:
 * node --import ./scripts/tsx.mjs scripts/perf/node-event-session-source-measure.mjs [label]
 * Five rounds of 5,000 events per workload; CPU is untraced, allocations use a
 * separate V8 sampling pass including collected objects. No Gateway or disk state.
 * Acceptance: one fewer decode per non-session event, lower allocation and CPU;
 * this owner measurement does not claim a whole-Gateway throughput improvement.
 */
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import {
  parseNodeEventPayload,
  withNodeEventSessionSource,
} from "../../src/gateway/server-node-event-source.ts";

const iterations = 5_000;
const rounds = 5;
const fixtures = [
  {
    event: "node.host.stats",
    payload: {
      cpuCount: 64,
      loadAverage: [24, 22, 23],
      memoryTotalBytes: 192 * 2 ** 30,
      memoryFreeBytes: 96 * 2 ** 30,
      diskTotalBytes: 2 ** 40,
      diskAvailableBytes: 2 ** 39,
    },
  },
  { event: "node.presence.activity", payload: { source: "app", idleSeconds: 4 } },
  {
    event: "exec.finished",
    payload: {
      sessionKey: "agent:main:synthetic-stress-session",
      runId: "synthetic-run",
      command: "synthetic-tool",
      exitCode: 0,
      output: "synthetic tool output\n".repeat(200),
    },
  },
];
const inspector = new Session();
inspector.connect();
let consumed = 0;
const rows = [];
try {
  for (const fixture of fixtures) {
    const event = { event: fixture.event, payloadJSON: JSON.stringify(fixture.payload) };
    const consume = async () => {
      if (parseNodeEventPayload(event.payloadJSON)) {
        consumed++;
      }
      return undefined;
    };
    const run = async () => {
      for (let index = 0; index < iterations; index++) {
        await withNodeEventSessionSource(event, undefined, consume);
      }
    };
    await run();
    for (let round = 0; round < rounds; round++) {
      const load = os.loadavg();
      const cpu = process.cpuUsage();
      const start = performance.now();
      await run();
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await run();
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const bytes = (node) =>
        node.selfSize + node.children.reduce((total, child) => total + bytes(child), 0);
      rows.push({
        event: event.event,
        round,
        iterations,
        cpuMs: (used.user + used.system) / 1000,
        elapsedMs,
        sampledBytes: bytes(profile.head),
        load,
      });
    }
  }
} finally {
  inspector.disconnect();
}
console.log(
  JSON.stringify({ label: process.argv[2], iterations, rounds, consumed, rows }, null, 2),
);
