/**
 * node --expose-gc scripts/perf/tool-activity-presentation-measure.mjs BASE_ROOT HEAD_ROOT
 * Exact source owners, synthetic live lifecycle bookkeeping and event sink. No SQL,
 * filesystem or Gateway claim: session/workspace scale is outside this owner.
 * Five counterbalanced A/A and A/B pairs; timing and collected-inclusive allocation
 * passes are separate. Acceptance: unchanged deltas, zero unrelated reads, linear
 * turn work, lower CPU/allocation at 100/500/1000 calls without a worse max segment.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { sampledOwnerBytes } from "../lib/sampled-owner-allocation.mjs";

const [base, head] = process.argv.slice(2);
assert(base && head && globalThis.gc, "expected --expose-gc and BASE_ROOT HEAD_ROOT");
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "activity-measure-")));
process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));
function section(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  assert(start >= 0 && end > start, `missing source section: ${from}`);
  return text.slice(start, end);
}
async function load(root, label) {
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const start = read("src/agents/embedded-agent-subscribe.handlers.tools.start.ts");
  const incremental = start.includes("toolActivityPresentation.drain()");
  const finalize = section(
    start,
    "export function finalizeToolActivity",
    "\nfunction extendExecMeta",
  );
  let source = "export const toolStartData = new Map();\n";
  source += section(
    start,
    "function* iterateRunToolStarts",
    "\nexport function countActiveToolExecutions",
  );
  source += "function emitToolActivityEvent(ctx, event) { ctx.events.push(event.data); }\n";
  if (incremental) {
    source += read("src/agents/tool-activity-presentation.ts").replace(/^import type .*;\n/m, "");
  } else {
    source += read("src/chat/tool-call-grouping.ts");
    source += section(
      read("src/agents/agent-activity-presentation.ts"),
      "export function resolveCompletedActivityWrappers",
      "\nexport function projectAgentActivityItem",
    );
  }
  source += finalize;
  const filename = path.join(scratch, label + ".mjs");
  writeFileSync(filename, stripTypeScriptTypes(source));
  const url = pathToFileURL(filename).href;
  return {
    ...(await import(url)),
    incremental,
    url,
    hash: createHash("sha256").update(source).digest("hex"),
  };
}
const owners = { A1: await load(base, "A1"), A2: await load(base, "A2"), B: await load(head, "B") };
function turn(owner, count) {
  const events = [];
  const state = {
    toolMetas: [],
    toolMetaById: new Map(),
    itemActiveIds: new Set(),
    itemStartedCount: 0,
    itemCompletedCount: 0,
    ...(owner.incremental
      ? { toolActivityPresentation: new owner.ToolActivityPresentation() }
      : {}),
  };
  const ctx = { params: { runId: "fixture" }, state, events };
  let maxSegmentMs = 0;
  const measure = (fn) => {
    const start = performance.now();
    fn();
    maxSegmentMs = Math.max(maxSegmentMs, performance.now() - start);
  };
  const start = (id, parent) =>
    measure(() => {
      owner.toolStartData.set(`fixture:${id}`, { parentToolCallId: parent });
      state.toolMetaById.set(id, {});
      state.itemActiveIds.add(id);
      state.itemStartedCount++;
      state.toolActivityPresentation?.start(id, parent);
    });
  const complete = (id, index) =>
    measure(() => {
      const { parentToolCallId } = owner.toolStartData.get(`fixture:${id}`);
      owner.toolStartData.delete(`fixture:${id}`);
      state.toolMetaById.delete(id);
      state.itemActiveIds.delete(id);
      state.itemCompletedCount++;
      const activity = {
        itemId: id,
        status: index % 7 === 0 ? "failed" : "completed",
        ...(index % 11 === 0 ? { hideFromChannelProgress: true } : {}),
      };
      const meta = { toolCallId: id, parentToolCallId, activity };
      state.toolMetas.push(meta);
      if (owner.incremental) {
        state.toolActivityPresentation.complete(meta);
        owner.finalizeToolActivity(ctx);
      } else if (parentToolCallId || state.toolMetas.some((call) => call.parentToolCallId === id)) {
        owner.finalizeToolActivity(ctx);
      }
    });
  // Multiple completed wrappers with late parallel children, as with yielded Code Mode.
  for (let index = 0; index < count; index++) {
    start(`call-${index}`, index % 20 ? `call-${index - (index % 20)}` : undefined);
  }
  for (let index = 0; index < count; index += 20) {
    complete(`call-${index}`, 1);
  }
  for (let index = 0; index < count; index++) {
    if (index % 20) {
      complete(`call-${index}`, index);
    }
  }
  measure(() => owner.finalizeToolActivity(ctx));
  return { maxSegmentMs, snapshot: JSON.stringify({ events, calls: state.toolMetas }) };
}
const rows = [];
console.log(
  JSON.stringify({
    kind: "protocol",
    hashes: Object.fromEntries(Object.entries(owners).map(([k, v]) => [k, v.hash])),
    node: process.version,
    load: loadavg(),
    pairs: 5,
    turns: 3,
    scope: "exact owner with synthetic lifecycle; no Gateway/SQL/workspace timing",
  }),
);
for (const count of [10, 100, 500, 1000]) {
  const expected = turn(owners.A1, count).snapshot;
  for (const owner of Object.values(owners)) {
    assert.equal(turn(owner, count).snapshot, expected, "presentation changed");
    for (let warm = 0; warm < 3; warm++) {
      turn(owner, count);
    }
  }
  for (const mode of ["cpu", "allocation"]) {
    const inspector = mode === "allocation" ? new Session() : undefined;
    inspector?.connect();
    for (let pair = 0; pair < 5; pair++) {
      for (const label of pair % 2 ? ["B", "A1", "A2", "A1"] : ["A1", "A2", "A1", "B"]) {
        const owner = owners[label];
        globalThis.gc();
        if (inspector) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpu = process.threadCpuUsage();
        const wall = performance.now();
        let maxSegmentMs = 0;
        for (let repeat = 0; repeat < 3; repeat++) {
          const result = turn(owner, count);
          maxSegmentMs = Math.max(maxSegmentMs, result.maxSegmentMs);
          assert.equal(result.snapshot, expected);
        }
        const elapsed = performance.now() - wall;
        const used = process.threadCpuUsage(cpu);
        const allocation = inspector
          ? sampledOwnerBytes(
              (await inspector.post("HeapProfiler.stopSampling")).profile,
              owner.url,
            )
          : undefined;
        const row = {
          kind: "sample",
          count,
          mode,
          pair,
          label,
          cpuMs: (used.user + used.system) / 3000,
          wallMs: elapsed / 3,
          maxSegmentMs,
          ...(allocation ? { bytes: allocation.bytes / 3, samples: allocation.samples } : {}),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
    inspector?.disconnect();
  }
}
const percentile = (values, p) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1];
for (const count of [10, 100, 500, 1000]) {
  for (const label of Object.keys(owners)) {
    const timing = rows.filter((r) => r.count === count && r.label === label && r.mode === "cpu");
    const allocation = rows.filter(
      (r) => r.count === count && r.label === label && r.mode === "allocation",
    );
    console.log(
      JSON.stringify({
        kind: "summary",
        count,
        label,
        cpuMedianMs: percentile(
          timing.map((r) => r.cpuMs),
          0.5,
        ),
        cpuP95Ms: percentile(
          timing.map((r) => r.cpuMs),
          0.95,
        ),
        maxSegmentMedianMs: percentile(
          timing.map((r) => r.maxSegmentMs),
          0.5,
        ),
        maxSegmentP95Ms: percentile(
          timing.map((r) => r.maxSegmentMs),
          0.95,
        ),
        bytesMedian: percentile(
          allocation.map((r) => r.bytes),
          0.5,
        ),
        bytesP95: percentile(
          allocation.map((r) => r.bytes),
          0.95,
        ),
      }),
    );
  }
}
for (const count of [10, 100, 500, 1000]) {
  const calls = Array.from({ length: count }, (_, index) => ({
    runId: "fixture",
    callId: `call-${index}`,
    ...(index % 20 ? { parentToolCallId: `call-${index - (index % 20)}` } : {}),
    activity: { status: "completed" },
  }));
  for (const method of ["groupToolCalls", "resolveCompletedActivityWrappers"]) {
    for (let warm = 0; warm < 10; warm++) {
      owners.A1[method](calls);
    }
    const cpu = process.threadCpuUsage();
    for (let repeat = 0; repeat < 100; repeat++) {
      owners.A1[method](calls);
    }
    const used = process.threadCpuUsage(cpu);
    console.log(
      JSON.stringify({
        kind: "micro",
        count,
        method,
        cpuMsPerCall: (used.user + used.system) / 100000,
        invocationsPerTurn: count - Math.ceil(count / 20) + 1,
        cardsGroupedPerTurn: count * (count - Math.ceil(count / 20) + 1),
      }),
    );
  }
}
