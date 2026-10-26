/**
 * Usage: node --expose-gc scripts/perf/subagent-mutation-clone-measure.ts BASE_ROOT CANDIDATE_ROOT [CALLS=3000] [PAIRS=5]
 * Exact owner-planning microbenchmark, not SQLite, transport, authorization, or Gateway proof.
 * Extracts the three production owner functions unchanged; admission and persistence are
 * in-memory stubs returning their planned postimages. Frozen fixtures model 64 retained
 * subagent rows with 2 KiB tasks, 16 KiB results, and pending delivery payloads.
 * Counterbalanced CPU passes run without sampling; separate allocation passes include
 * collected objects. JSON lines report source hashes, host load, CPU/work, bytes/work,
 * GC and RSS/heap. TMPDIR owns temporary modules, removed when the process exits.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.ts";

const [baseRoot, candidateRoot, callsArg = "3000", pairsArg = "5"] = process.argv.slice(2);
assert(baseRoot && candidateRoot, "expected BASE_ROOT CANDIDATE_ROOT [CALLS] [PAIRS]");
assert(globalThis.gc, "run with --expose-gc");
const calls = Number(callsArg);
const pairs = Number(pairsArg);
assert(Number.isSafeInteger(calls) && calls > 0, "CALLS must be a positive integer");
assert(Number.isSafeInteger(pairs) && pairs > 0, "PAIRS must be a positive integer");
const generatedRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "subagent-mutation-")));
process.once("exit", () => rmSync(generatedRoot, { recursive: true, force: true }));
const sources = {
  admit: "src/agents/subagents/completion/subagent-completion-delivery.ts",
  settle: "src/agents/subagents/completion/subagent-completion-admission.store.ts",
  cleanup: "src/agents/subagents/registry/subagent-registry-sweep-cleanup.ts",
  delivery: "src/agents/subagents/registry/subagent-delivery-state.ts",
};
type Flow = "admit" | "settle" | "cleanup";
type Side = "base" | "candidate";
type Owner = {
  run: (flow: Flow, row: SubagentRunRecord) => Promise<SubagentRunRecord>;
  url: string;
  hashes: Record<string, string>;
};

function between(source: string, start: string, end?: string): string {
  assert.equal(source.split(start).length, 2, `expected one ${start}`);
  const tail = source.slice(source.indexOf(start));
  if (!end) {
    return tail;
  }
  assert.equal(tail.split(end).length, 2, `expected one ${end}`);
  return tail.slice(0, tail.indexOf(end));
}

async function load(root: string, side: Side): Promise<Owner> {
  const text = Object.fromEntries(
    Object.entries(sources).map(([key, file]) => [
      key,
      readFileSync(path.join(root, file), "utf8"),
    ]),
  );
  const hashes = Object.fromEntries(
    Object.entries(text).map(([key, source]) => [
      key,
      createHash("sha256").update(source).digest("hex"),
    ]),
  );
  const code = stripTypeScriptTypes(`
${between(text.admit!, "export async function admitCorrelatedSubagentSessionDelivery(", "export function resolveCorrelatedSubagentDelivery(")}
${between(text.settle!, "export async function settleSubagentCompletionDelivery(", "export async function blockSubagentCompletionDelivery(")}
${between(text.cleanup!, "export function mutateCleanup(")}
${between(text.delivery!, "export function ensureDeliveryState(", "export function clearDeliveryState(")}
const Date = { now: () => 1000000 };
const CLAIM_LEASE_MS = 125000;
const SESSION_DELIVERY_DEADLINE_MS = 3600000;
const CANONICAL_RESULT_PROMPT = "Synthetic completion ready for review";
class SubagentCompletionSourceChangedError extends Error {}
const subagentRuns = new Map();
let result;
const isSameSubagentRunOwner = (current, expected) => current === expected;
const isCleanupCurrent = isSameSubagentRunOwner;
const currentCompletionOwner = (rows, expected) => {
  if (rows.get(expected.runId) !== expected) throw new Error("unexpected benchmark owner");
  return expected;
};
const withSessionDeliveryEnqueueAdmission = async (_payload, _context, run) => run(() => {});
const prepareClaimedSessionDelivery = (payload) => ({ ...payload, id: "synthetic-queue" });
const loadPendingFinalDeliveryPayload = () => { throw new Error("fixture must have delivery payload"); };
async function admitSubagentCompletionDelivery(params) {
  params.assertCurrent();
  result = params.plan(subagentRuns.get(params.runId)).subagent;
  return { id: "synthetic-queue", claimed: true, status: "claimed" };
}
async function mutateCompletion(_rows, plan) { result = plan(subagentRuns).subagent; }
async function mutateSubagentRuns(_ids, plan, { runs }) { return plan(runs).value; }
export async function run(flow, row) {
  subagentRuns.set(row.runId, row);
  if (flow === "admit") {
    await admitCorrelatedSubagentSessionDelivery({ runId: row.runId,
      payload: { messageId: "synthetic-message", message: "fixture" }, queueContext: {} });
  } else if (flow === "settle") {
    await settleSubagentCompletionDelivery({ subagent: row, queueId: "synthetic-queue" });
  } else {
    result = await mutateCleanup(subagentRuns, row, () => true, (draft) => {
      draft.execution.suppressSessionEffects = true;
      draft.contextEngineCleanupCompletedAt = 1000000;
    });
  }
  return result;
}
`);
  const file = path.join(generatedRoot, `${side}.mjs`);
  writeFileSync(file, code);
  const url = pathToFileURL(file).href;
  // The generated module exports the exact typed owners behind the synthetic adapters above.
  const module: Pick<Owner, "run"> = await import(url);
  return { run: module.run, url, hashes };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const rows = Array.from({ length: 64 }, (_, index): SubagentRunRecord => {
  const task = `Synthetic task ${index}: ${"task instructions. ".repeat(120)}`;
  const row: SubagentRunRecord = {
    runId: `run-${index}`,
    childSessionKey: `agent:main:subagent:child-${index}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    createdAt: 1,
    task,
    cleanup: "keep",
    expectsCompletionMessage: true,
    execution: { status: "terminal", startedAt: 100, endedAt: 200, outcome: { status: "ok" } },
    completion: {
      required: true,
      resultText: `Result ${index}: ${"retained result. ".repeat(1024)}`,
    },
    delivery: {
      status: "pending",
      generation: 1,
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey: `agent:main:subagent:child-${index}`,
        childRunId: `run-${index}`,
        task,
      },
    },
  };
  return freeze(row);
});
const owners = {
  base: await load(baseRoot, "base"),
  candidate: await load(candidateRoot, "candidate"),
};
const samplingInterval = 4096;
const flows: Flow[] = ["admit", "settle", "cleanup"];
let gcEntries: PerformanceEntry[] = [];
const observer = new PerformanceObserver((list) => gcEntries.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
let checksum = 0;

function sampledBytes(profile: HeapProfiler.SamplingHeapProfile, url: string): number {
  function visit(node: HeapProfiler.SamplingHeapProfileNode, inherited = false): number {
    const owned = inherited || node.callFrame.url === url;
    return (
      (owned ? node.selfSize : 0) +
      node.children.reduce((sum, child) => sum + visit(child, owned), 0)
    );
  }
  return visit(profile.head);
}
console.log(
  JSON.stringify({
    protocol: "subagent-mutation-clone-v1",
    node: process.version,
    calls,
    pairs,
    rows: rows.length,
    fixtureBytes: Buffer.byteLength(JSON.stringify(rows[0])),
    samplingInterval,
    hashes: { base: owners.base.hashes, candidate: owners.candidate.hashes },
    scope:
      "Exact owner planning; synthetic admission/persistence; no Gateway or authorization claim",
  }),
);
try {
  for (const flow of flows) {
    const before = JSON.stringify(rows);
    const base = await owners.base.run(flow, rows[0]!);
    const candidate = await owners.candidate.run(flow, rows[0]!);
    assert.deepEqual(candidate, base, `${flow} postimages differ`);
    assert.notEqual(candidate, rows[0]);
    assert.equal(JSON.stringify(rows), before, `${flow} changed its source`);
    for (const owner of Object.values(owners)) {
      for (let index = 0; index < Math.min(calls, 200); index++) {
        await owner.run(flow, rows[index % rows.length]!);
      }
    }
    for (const mode of ["cpu", "allocation"]) {
      const inspector = mode === "allocation" ? new Session() : undefined;
      inspector?.connect();
      try {
        for (let pair = 0; pair < pairs; pair++) {
          const order: Side[] = pair % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
          for (const side of order) {
            globalThis.gc();
            await nextTurn();
            await nextTurn();
            gcEntries = [];
            if (inspector) {
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            const hostLoad = loadavg();
            const cpu = process.cpuUsage();
            const thread = process.threadCpuUsage();
            const started = performance.now();
            for (let index = 0; index < calls; index++) {
              checksum += (await owners[side].run(flow, rows[index % rows.length]!)).task.length;
            }
            const ended = performance.now();
            const cpuUsed = process.cpuUsage(cpu);
            const threadUsed = process.threadCpuUsage(thread);
            const memory = process.memoryUsage();
            const bytes = inspector
              ? sampledBytes(
                  (await inspector.post("HeapProfiler.stopSampling")).profile,
                  owners[side].url,
                )
              : undefined;
            await nextTurn();
            await nextTurn();
            const pauses = gcEntries.filter(
              (entry) => entry.startTime >= started && entry.startTime < ended,
            );
            const gcByKind = new Map<number, { count: number; totalMs: number; maxMs: number }>();
            for (const entry of pauses) {
              const kind = (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind;
              const stats = gcByKind.get(kind) ?? { count: 0, totalMs: 0, maxMs: 0 };
              stats.count++;
              stats.totalMs += entry.duration;
              stats.maxMs = Math.max(stats.maxMs, entry.duration);
              gcByKind.set(kind, stats);
            }
            console.log(
              JSON.stringify({
                flow,
                mode,
                side,
                pair,
                calls,
                hostLoad,
                wallUsPerOp: ((ended - started) * 1000) / calls,
                processCpuUsPerOp: (cpuUsed.user + cpuUsed.system) / calls,
                threadCpuUsPerOp: (threadUsed.user + threadUsed.system) / calls,
                sampledBytesPerOp: bytes === undefined ? undefined : bytes / calls,
                gcMs: pauses.reduce((sum, entry) => sum + entry.duration, 0),
                gcMaxMs: Math.max(0, ...pauses.map((entry) => entry.duration)),
                gcCount: pauses.length,
                gcByKind: Object.fromEntries(gcByKind),
                rssBytes: memory.rss,
                heapUsedBytes: memory.heapUsed,
              }),
            );
          }
        }
      } finally {
        inspector?.disconnect();
      }
    }
    assert.equal(JSON.stringify(rows), before, `${flow} changed its source during measurement`);
  }
  assert(checksum > 0);
} finally {
  observer.disconnect();
}
