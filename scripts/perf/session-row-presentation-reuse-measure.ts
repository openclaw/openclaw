/**
 * Owner-only cache-miss benchmark: prepare temporal facts, then present the row.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-presentation-reuse-measure.ts \
 *   --iterations 3000 [--allocation] [--source-file .local/base/session-utils-row.ts]
 * Save the baseline owner with git show before editing. Alternate base/candidate
 * processes; allocation sampling runs separately from untraced CPU measurements.
 * Defaults cycle 100-row pages through 10,000 immutable completed child sessions.
 * Imports, materialization, warmup, work-count proof and wire hashing are untimed.
 * The digest covers every fixture at one fixed clock, preserving JSON field order.
 * Both arms prepare the same live facts; the baseline owner ignores the handoff.
 * This measures presentation misses, not cache hit frequency, viewers, SQLite,
 * socket transport, real model work or whole-Gateway throughput/latency.
 * Reject timing pairs with 1-minute host load above 40 at either boundary.
 */
import assert from "node:assert/strict";
import { createHash, hash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    "source-file": { type: "string" },
    iterations: { type: "string", default: "3000" },
    rows: { type: "string", default: "10000" },
    "page-size": { type: "string", default: "100" },
    allocation: { type: "boolean", default: false },
  },
});
assert(global.gc, "Use --expose-gc");
const stateDir = path.resolve(".local/session-row-presentation-reuse/state");
mkdirSync(stateDir, { recursive: true });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
const integer = (name: "iterations" | "rows" | "page-size", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: name, min: 1, fallback });
const iterations = integer("iterations", 3000);
const rowCount = integer("rows", 10000);
const pageSize = integer("page-size", 100);
const ownerUrl = new URL("../../src/gateway/session-utils-row.ts", import.meta.url);
const source = readFileSync(values["source-file"] ?? ownerUrl, "utf8");
let replaced = false;
if (values["source-file"]) {
  const compiled = transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code;
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl.href) {
        return nextLoad(url, context);
      }
      replaced = true;
      return { format: "module", source: compiled, shortCircuit: true };
    },
  });
}
const { buildSubagentRunReadIndexFromRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-queries.js");
const { buildSessionListRowMetadataContext } =
  await import("../../src/gateway/session-utils-projection.js");
const { materializeSessionRow, presentSessionRow, readSessionRowInputs } =
  await import("../../src/gateway/session-utils-row.js");
const { projectPreparedSessionRunState } =
  await import("../../src/gateway/session-row-prepared-read.js");
assert(!values["source-file"] || replaced, "Baseline owner substitution did not run");
const now = 1_800_000_000_000;
const cfg: OpenClawConfig = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
const runs = new Map<string, SubagentRunReadRecord>();
for (let index = 0; index < rowCount; index++) {
  const runId = `synthetic-${index}`;
  runs.set(runId, {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: `agent:main:dashboard:parent-${index % 70}`,
    createdAt: now - 10_000,
    execution: { status: "terminal", startedAt: now - 9_000, endedAt: now - 1_000 },
  });
}
const subagentRuns = buildSubagentRunReadIndexFromRuns({ runs, inMemoryRuns: [], now });
const rowContext = buildSessionListRowMetadataContext({ now, subagentRuns });
const rows = [...runs.values()].map((record) => {
  const entry = Object.freeze({
    sessionId: record.runId,
    updatedAt: now - 1_000,
    spawnedBy: record.requesterSessionKey,
    label: `Synthetic completed task ${record.runId}`,
  });
  const { inputs } = readSessionRowInputs({
    cfg,
    key: record.childSessionKey,
    agentId: "main",
    entry,
    store: {},
    storePath: "/synthetic/main.sqlite",
    rowContext,
    active: false,
    activeModel: null,
    terminalModel: null,
    preparedAcpMeta: null,
    preparedRuntimeOwnership: null,
    preparedModelMetadata: null,
    preparedRepositoryWorkspace: null,
    childLinks: [],
    lightweightListRow: true,
    skipTranscriptUsageFallback: true,
    now,
  });
  return materializeSessionRow(inputs);
});
const childActivity = { childSessions: undefined, hasActiveSubagentRun: false };
function present(index: number, context = rowContext) {
  const materialized = rows[index % rows.length]!;
  const preparedRunState = projectPreparedSessionRunState(
    materialized.row.key,
    materialized.source,
    now,
    context,
  );
  return presentSessionRow(materialized, {
    now,
    subagentRuns: context.subagentRuns,
    projectedAgentRuns: context.projectedAgentRuns,
    projectedSubagentActivity: context.projectedSubagentActivity,
    preparedRunState,
    childActivity,
    backgroundProcessCount: 0,
  });
}
let runReads = 0;
const countedContext = {
  ...rowContext,
  subagentRuns: {
    ...subagentRuns,
    getDisplaySubagentRun(...args: Parameters<typeof subagentRuns.getDisplaySubagentRun>) {
      runReads++;
      return subagentRuns.getDisplaySubagentRun(...args);
    },
  },
};
const digest = createHash("sha256");
for (let index = 0; index < rows.length; index++) {
  digest.update(JSON.stringify(present(index, countedContext)));
}
function run(count: number) {
  let checksum = 0;
  for (let index = 0; index < count * pageSize; index++) {
    const row = present(index);
    checksum += row.runtimeMs ?? 0;
  }
  return checksum;
}
run(Math.ceil(rowCount / pageSize));
global.gc();
const inspector = new Session();
try {
  if (values.allocation) {
    await startCollectedHeapSampling(inspector, 1024);
  }
  const loadStart = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  const checksum = run(iterations);
  const elapsedMs = performance.now() - started;
  const usedCpu = process.threadCpuUsage(cpu);
  const loadEnd = loadavg();
  const allocatedBytes = values.allocation
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  global.gc();
  const memoryAfter = process.memoryUsage();
  const operations = iterations * pageSize;
  assert.equal(checksum, operations * 8_000);
  console.log(
    JSON.stringify({
      mode: values.allocation ? "allocation" : "timing",
      ownerSha256: hash("sha256", source),
      node: process.version,
      rowCount,
      pageSize,
      iterations,
      operations,
      work: { rows: rowCount, displayRunReads: runReads },
      wireDigest: digest.digest("hex"),
      mainThreadCpuUsPerRow: (usedCpu.user + usedCpu.system) / operations,
      allocationBytesPerRow: allocatedBytes === undefined ? undefined : allocatedBytes / operations,
      retainedHeapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
      elapsedMs,
      loadStart,
      loadEnd,
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  if (values.allocation) {
    inspector.disconnect();
  }
}
