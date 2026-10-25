// Synthetic progress capture through the replay owner; no transport or Gateway claim.
// Run: node --import ./scripts/tsx.mjs scripts/perf/chat-progress-capture-measure.ts
// Repeat with --allocations for a separate sampled pass; its CPU is not a timing gate.
// Use the same command on base and candidate; live load proof uses transcript-broadcast-measure.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { updateChatRunProgressSnapshot } from "../../src/gateway/server-chat-progress-snapshot.js";

const eventCount = 50_000;
const { values } = parseArgs({ options: { allocations: { type: "boolean", default: false } } });
const result = {
  content: Array.from({ length: 12 }, (_, index) => ({
    type: "text",
    text: `src/fixture-${index}.ts: export const ready = true;\n`.repeat(8),
    line: index,
    matched: true,
  })),
  details: { exitCode: 0, truncated: false, signal: null },
};
const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
const inspector = new Session();
inspector.connect();
try {
  for (const mode of ["summary", "full"] as const) {
    const snapshots: Array<ReturnType<typeof updateChatRunProgressSnapshot>> = Array.from(
      { length: 12 },
      () => undefined,
    );
    const run = (count: number, offset: number) => {
      for (let index = 0; index < count; index++) {
        const slot = index % snapshots.length;
        const seq = offset + index + 1;
        snapshots[slot] = updateChatRunProgressSnapshot(
          snapshots[slot],
          {
            runId: `run-${slot}`,
            sessionKey: `agent:main:synthetic-${slot}`,
            seq,
            ts: seq,
            stream: "tool",
            data: { phase: "result", toolCallId: "read-1", name: "read", result },
          },
          mode,
        );
      }
    };
    run(5_000, 0);
    for (let sample = 0; sample < 5; sample++) {
      if (values.allocations) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.threadCpuUsage();
      const start = performance.now();
      run(eventCount, 5_000 + sample * eventCount);
      const wallMs = performance.now() - start;
      const used = process.threadCpuUsage(cpu);
      const allocation = values.allocations
        ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      const events = snapshots.flatMap((snapshot) => snapshot?.events ?? []);
      for (const snapshot of snapshots) {
        assert.equal(snapshot?.events.length, 1);
        assert.equal(snapshot.byteLength, Buffer.byteLength(JSON.stringify(snapshot.events[0])));
      }
      console.log(
        JSON.stringify({
          mode,
          sample,
          eventCount,
          wallMs,
          cpuMs: (used.user + used.system) / 1000,
          allocatedBytes: allocation,
          digest: createHash("sha256").update(JSON.stringify(events)).digest("hex"),
        }),
      );
    }
  }
} finally {
  inspector.disconnect();
}
