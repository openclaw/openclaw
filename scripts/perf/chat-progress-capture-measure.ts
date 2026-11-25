// Synthetic progress capture through the replay owner; no transport or Gateway claim.
// Run: node --import ./scripts/tsx.mjs scripts/perf/chat-progress-capture-measure.ts
// Repeat with --allocations for a separate sampled pass; its CPU is not a timing gate.
// --events 5000 --retained-tools 16 exercises interleaved retained histories.
// --module <absolute-path> selects a frozen owner exposing the current update/read contract.
// --workload stream --compare <baseline-module> checks replay after every event.
// Use the same command on base and candidate; live load proof uses transcript-broadcast-measure.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    allocations: { type: "boolean", default: false },
    events: { type: "string", default: "50000" },
    "retained-tools": { type: "string", default: "1" },
    module: { type: "string" },
    compare: { type: "string" },
    workload: { type: "string", default: "results" },
  },
});
const eventCount = Number(values.events);
const retainedTools = Number(values["retained-tools"]);
assert(Number.isSafeInteger(eventCount) && eventCount > 0);
assert(Number.isSafeInteger(retainedTools) && retainedTools > 0 && retainedTools <= 16);
const {
  readChatRunProgressEvents,
  updateChatRunProgressSnapshot,
}: typeof import("../../src/gateway/server-chat-progress-snapshot.js") = await import(
  values.module
    ? pathToFileURL(values.module).href
    : "../../src/gateway/server-chat-progress-snapshot.js"
);
assert.equal(typeof updateChatRunProgressSnapshot, "function");
assert.equal(typeof readChatRunProgressEvents, "function");
assert(["results", "stream"].includes(values.workload));
const comparison: typeof import("../../src/gateway/server-chat-progress-snapshot.js") | undefined =
  values.compare ? await import(pathToFileURL(values.compare).href) : undefined;
const result = {
  content: Array.from({ length: 12 }, (_, index) => ({
    type: "text",
    text: `src/fixture-${index}.ts: export const ready = true;\n`.repeat(8),
    line: index,
    matched: true,
  })),
  details: { exitCode: 0, truncated: false, signal: null },
};
// A busy synthetic cohort: 48 runs with interleaved tools, usage, scalar item
// progress, escaped output tails, and oversized tool results. No database or
// workspace is read: those inventories do not participate in this owner.
const text = 'fixture.ts: ready\n"é🦞\ud800'.repeat(180);
const output = Object.freeze({ text, liveOutput: Object.freeze({ text, omittedChars: 100_000 }) });
const largeResult = { content: [{ type: "text", text: text.repeat(40) }] };
function eventAt(index: number, offset: number, slots: number) {
  const slot = index % slots;
  const seq = offset + index + 1;
  const turn = Math.floor((seq - 1) / slots);
  const toolCallId = `read-${Math.floor(turn / 20) % retainedTools}`;
  const stage = turn % 20;
  let stream = "tool";
  let data: Record<string, unknown> = {
    phase: "result",
    toolCallId: `read-${turn % retainedTools}`,
    name: "read",
    result,
  };
  if (values.workload === "stream") {
    if (stage === 0) {
      stream = "run_status";
      data = { phase: "waiting_for_model", message: "Waiting" };
    } else if (stage === 1) {
      data = { phase: "start", toolCallId, name: "read", args: { path: "src/fixture.ts" } };
    } else if (stage === 2 || stage === 18) {
      stream = "usage";
      data = stage === 2 ? { activeContextTokens: 48_000 } : { outputTokens: turn * 10 };
    } else if (stage === 10 || stage === 15) {
      data = { phase: "update", toolCallId, name: "exec", outputOnly: true, partialResult: output };
    } else if (stage === 17) {
      data = {
        phase: "result",
        toolCallId,
        name: "read",
        result: Math.floor(turn / 20) % 2 ? result : largeResult,
      };
    } else if (stage === 19) {
      stream = "notice";
      data = { phase: "warning", message: text };
    } else {
      stream = "item";
      data = {
        kind: "tool",
        phase: "update",
        itemId: `tool:${toolCallId}`,
        toolCallId,
        name: "read",
        title: "Read synthetic file",
        status: "running",
        progressText: `Reading ${stage}`,
      };
    }
  }
  return {
    runId: `run-${slot}`,
    sessionKey: `agent:main:synthetic-${slot}`,
    seq,
    ts: seq,
    stream,
    data,
  };
}
const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
const inspector = new Session();
inspector.connect();
try {
  for (const mode of ["summary", "full"] as const) {
    const snapshots: Array<ReturnType<typeof updateChatRunProgressSnapshot>> = Array.from(
      { length: values.workload === "stream" ? 48 : 12 },
      () => undefined,
    );
    const run = (count: number, offset: number) => {
      for (let index = 0; index < count; index++) {
        const slot = index % snapshots.length;
        snapshots[slot] = updateChatRunProgressSnapshot(
          snapshots[slot],
          eventAt(index, offset, snapshots.length),
          mode,
        );
      }
    };
    if (comparison) {
      const other: typeof snapshots = Array.from({ length: snapshots.length }, () => undefined);
      for (let index = 0; index < eventCount; index++) {
        const slot = index % snapshots.length;
        // Separate producer envelopes keep reference retention from influencing the oracle.
        snapshots[slot] = updateChatRunProgressSnapshot(
          snapshots[slot],
          eventAt(index, 0, snapshots.length),
          mode,
        );
        other[slot] = comparison.updateChatRunProgressSnapshot(
          other[slot],
          eventAt(index, 0, snapshots.length),
          mode,
        );
        assert.deepEqual(
          readChatRunProgressEvents(snapshots[slot]),
          comparison.readChatRunProgressEvents(other[slot]),
        );
        assert.equal(snapshots[slot]?.byteLength, other[slot]?.byteLength);
        assert.equal(snapshots[slot]?.lastSeq, other[slot]?.lastSeq);
      }
      snapshots.fill(undefined);
    }
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
      const events = snapshots.flatMap((snapshot) => {
        assert.ok(snapshot);
        const retained = readChatRunProgressEvents(snapshot);
        assert.ok(retained);
        if (values.workload === "results") {
          assert.equal(retained.length, retainedTools);
        }
        assert(retained.length <= 50);
        assert(snapshot.byteLength <= 128 * 1024);
        assert.equal(
          snapshot.byteLength,
          retained.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0),
        );
        return retained;
      });
      console.log(
        JSON.stringify({
          mode,
          workload: values.workload,
          sample,
          eventCount,
          retainedTools,
          load: loadavg(),
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
