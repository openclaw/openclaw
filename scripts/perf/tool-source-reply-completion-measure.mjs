/**
 * Usage: node --expose-gc scripts/perf/tool-source-reply-completion-measure.mjs BASE_ROOT CANDIDATE_ROOT [CALLS=5000]
 * Exact-owner microbenchmark; no whole-Gateway or provider-performance claim. Each
 * operation creates a 64-cell tool batch, delivers its first cell, waits for its
 * last sibling, settles, rejects replay and cross-input reuse, then accepts a
 * direct final reply. Input-scope lookup and provenance storage are in-memory
 * stubs; the full completion owner is loaded from each root with source hashes.
 * Its single constructor parameter property is mechanically expanded to an own
 * field assignment before Node's native TypeScript stripping.
 * Five serial AB/BA pairs measure untraced CPU, followed by a separate sampled
 * allocation pass (1024-byte interval, including objects collected during it).
 * CPU includes fixture work; owner-attributed allocation excludes fixture code.
 * GC is reported per arm and kind, not a reliable tail gate for this short run.
 * JSON lines include counts, host load, process/main-thread CPU, GC, RSS/heap,
 * sampled bytes, and paired summaries. TMPDIR owns temporary transformed modules.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [baseRoot, candidateRoot, callsArg = "5000"] = process.argv.slice(2);
assert(baseRoot && candidateRoot, "expected BASE_ROOT CANDIDATE_ROOT");
assert(globalThis.gc, "run with --expose-gc");
const calls = Number(callsArg);
assert(Number.isSafeInteger(calls) && calls > 0, "CALLS must be a positive integer");
const pairs = 5;
const cellsPerOp = 64;
const completionsPerOp = 5;
const samplingInterval = 1024;
const generatedRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "tool-source-reply-")));
process.once("exit", () => rmSync(generatedRoot, { recursive: true, force: true }));

async function load(root, side) {
  const source = readFileSync(
    path.join(root, "src/agents/tool-source-reply-completion.ts"),
    "utf8",
  );
  const imports = [
    'import { getAgentToolInputScope } from "../../packages/agent-core/src/tool-execution-context.js";',
    'import {\n  attachInternalToolResultProvenance,\n  getInternalToolResultProvenance,\n} from "./runtime/internal-hooks.js";',
  ];
  let transformed = source;
  for (const statement of imports) {
    assert.equal(transformed.split(statement).length, 2, `expected one import: ${statement}`);
    transformed = transformed.replace(statement, "");
  }
  const constructor = "constructor(readonly inputScope = getAgentToolInputScope()) {}";
  assert.equal(
    transformed.split(constructor).length,
    2,
    "expected one inputScope parameter property",
  );
  transformed = transformed.replace(
    constructor,
    "inputScope; constructor(inputScope = getAgentToolInputScope()) { this.inputScope = inputScope; }",
  );
  const stubs = `
const provenance = new WeakMap();
function getAgentToolInputScope() { return undefined; }
function attachInternalToolResultProvenance(value, source) { provenance.set(value, source); return value; }
function getInternalToolResultProvenance(value) { return provenance.get(value); }
`;
  const filename = path.join(generatedRoot, `${side}.mjs`);
  writeFileSync(filename, stripTypeScriptTypes(stubs + transformed));
  const url = pathToFileURL(filename).href;
  return { ...(await import(url)), url, sha256: createHash("sha256").update(source).digest("hex") };
}

const owners = {
  base: await load(baseRoot, "base"),
  candidate: await load(candidateRoot, "candidate"),
};
function operation(owner) {
  const scope = {};
  const completion = owner.createSourceReplyBatchCompletion();
  const cells = Array.from({ length: cellsPerOp }, () => new owner.ToolSourceReplyCell(scope));
  cells[0].observe(owner.markFinalSourceReplyResult({}));
  const results = cells.map((cell, index) =>
    cell.attach({}, index === cells.length - 1 ? "waiting" : "completed", scope),
  );
  // Observation and result delivery may both report the same control.
  completion.observe(results[0]);
  let outcomes = Number(completion.complete(results, false, scope));
  const settled = cells.at(-1).attach({}, "completed", scope);
  outcomes |= Number(completion.complete([settled], false, scope)) << 1;
  outcomes |= Number(completion.complete(results, false, scope)) << 2;
  const nextScope = {};
  const late = cells[0].attach({}, "completed", nextScope);
  outcomes |= Number(completion.complete([late], false, nextScope)) << 3;
  outcomes |= Number(completion.complete([], true, nextScope)) << 4;
  return outcomes;
}
const expectedOutcomes = 18;
for (const owner of Object.values(owners)) {
  assert.equal(operation(owner), expectedOutcomes, "batch settlement or input isolation changed");
  for (let index = 0; index < Math.min(200, calls); index++) {
    operation(owner);
  }
}

function sampledOwnerBytes(profile, url) {
  const ids = new Set();
  function visit(node, inherited = false) {
    const owned = inherited || node.callFrame.url === url;
    if (owned) {
      ids.add(node.id);
    }
    return (
      (owned ? node.selfSize : 0) +
      node.children.reduce((sum, child) => sum + visit(child, owned), 0)
    );
  }
  return {
    bytes: visit(profile.head),
    samples: profile.samples.filter((sample) => ids.has(sample.nodeId)).length,
  };
}

let gcEntries = [];
const observer = new PerformanceObserver((list) => gcEntries.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
const rows = [];
console.log(
  JSON.stringify({
    protocol: "tool-source-reply-completion-v1",
    node: process.version,
    pairs,
    calls,
    cellsPerOp,
    completionsPerOp,
    samplingInterval,
    sha256: { base: owners.base.sha256, candidate: owners.candidate.sha256 },
    scope:
      "Exact completion owner with in-memory provenance and input-scope stubs; no Gateway claim",
  }),
);
try {
  for (const mode of ["cpu", "allocation"]) {
    const inspector = mode === "allocation" ? new Session() : undefined;
    inspector?.connect();
    try {
      for (let pair = 0; pair < pairs; pair++) {
        for (const side of pair % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"]) {
          globalThis.gc();
          await setImmediate();
          await setImmediate();
          gcEntries = [];
          if (inspector) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const hostLoadStart = loadavg();
          const cpu = process.cpuUsage();
          const thread = process.threadCpuUsage?.();
          const started = performance.now();
          let checksum = 0;
          for (let index = 0; index < calls; index++) {
            checksum += operation(owners[side]);
          }
          const ended = performance.now();
          const cpuUsed = process.cpuUsage(cpu);
          const threadUsed = thread && process.threadCpuUsage(thread);
          const memory = process.memoryUsage();
          const hostLoadEnd = loadavg();
          const allocation = inspector
            ? sampledOwnerBytes(
                (await inspector.post("HeapProfiler.stopSampling")).profile,
                owners[side].url,
              )
            : undefined;
          assert.equal(checksum, calls * expectedOutcomes);
          await setImmediate();
          await setImmediate();
          const pauses = gcEntries.filter(
            (entry) => entry.startTime >= started && entry.startTime < ended,
          );
          const byKind = new Map();
          for (const entry of pauses) {
            const kind = entry.detail.kind;
            const stats = byKind.get(kind) ?? { kind, count: 0, totalMs: 0, maxMs: 0 };
            stats.count++;
            stats.totalMs += entry.duration;
            stats.maxMs = Math.max(stats.maxMs, entry.duration);
            byKind.set(kind, stats);
          }
          const row = {
            mode,
            side,
            pair,
            calls,
            cells: calls * cellsPerOp,
            completions: calls * completionsPerOp,
            hostLoadStart,
            hostLoadEnd,
            wallUsPerOp: ((ended - started) * 1000) / calls,
            processCpuUsPerOp: (cpuUsed.user + cpuUsed.system) / calls,
            mainThreadCpuUsPerOp: threadUsed ? (threadUsed.user + threadUsed.system) / calls : null,
            gcMs: pauses.reduce((sum, entry) => sum + entry.duration, 0),
            gcMaxMs: Math.max(0, ...pauses.map((entry) => entry.duration)),
            gcCount: pauses.length,
            gcByKind: [...byKind.values()],
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            ...(allocation
              ? {
                  sampledBytesPerOp: allocation.bytes / calls,
                  allocationSamples: allocation.samples,
                }
              : {}),
          };
          rows.push(row);
          console.log(JSON.stringify(row));
        }
      }
    } finally {
      inspector?.disconnect();
    }
  }
  for (const [mode, metric] of [
    ["cpu", "processCpuUsPerOp"],
    ["cpu", "mainThreadCpuUsPerOp"],
    ["allocation", "sampledBytesPerOp"],
  ]) {
    const selected = rows.filter((row) => row.mode === mode);
    if (selected.some((row) => row[metric] === null)) {
      continue;
    }
    const mean = (side) =>
      selected.filter((row) => row.side === side).reduce((sum, row) => sum + row[metric], 0) /
      pairs;
    const base = mean("base"),
      candidate = mean("candidate");
    console.log(
      JSON.stringify({
        summary: metric,
        mode,
        base,
        candidate,
        absoluteDelta: candidate - base,
        deltaPercent: (candidate / base - 1) * 100,
      }),
    );
  }
} finally {
  observer.disconnect();
}
