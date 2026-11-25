/**
 * Main-thread hydration publication: freeze a decoded 5K-entry worker reply,
 * adopt it into SessionManager, then publish initial model context.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-hydration-clone-measure.ts
 *   --output /isolated/result.json [--owner-file /isolated/base-codec.ts] [--allocation]
 * Run five counterbalanced A/A and A/B pairs; allocation separately from timing.
 * Acceptance: identical history/context bytes, lower CPU and allocation, no >20%
 * p95/max-task regression. Transport, SQL, and unrelated workspace size are excluded.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  sessionManagerReadTranscriptBranch,
  type PreparedSessionTranscriptReload,
} from "../../src/agents/sessions/session-manager-view-types.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    output: { type: "string" },
    operations: { type: "string", default: "10" },
    entries: { type: "string", default: "5000" },
    "result-bytes": { type: "string", default: "16384" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values.output && globalThis.gc, "--output and --expose-gc required");
const operations = Number(values.operations);
const entries = Number(values.entries);
const resultBytes = Number(values["result-bytes"]);
assert(
  [operations, entries, resultBytes].every((value) => Number.isSafeInteger(value) && value > 0),
);
const ownerUrl = new URL("../../src/agents/sessions/session-manager-codec.ts", import.meta.url);
const replaced = registerPerfOwnerReplacement(ownerUrl.href, values["owner-file"]);
const { SessionManagerCore } = await import("../../src/agents/sessions/session-manager-core.js");
const { buildInitialContext } = await import("../../src/agents/sessions/session-manager-codec.js");
const { freezeTranscriptSnapshot } =
  await import("../../src/config/sessions/transcript-snapshot.js");
assert(!values["owner-file"] || replaced(), "Baseline owner was not loaded");

class ReloadManager extends SessionManagerCore {
  adopt(prepared: PreparedSessionTranscriptReload) {
    this.adoptPreparedTranscriptReload(prepared, undefined, {
      agentId: "main",
      sessionId: "synthetic",
      sessionKey: "agent:main:synthetic",
      storePath: "/synthetic/unused.sqlite",
    });
  }
}
const fixture = {
  events: [
    {
      type: "session",
      version: 4,
      id: "synthetic",
      cwd: "/synthetic",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    ...Array.from({ length: entries }, (_, index) => ({
      type: "message",
      id: `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "read",
        timestamp: index,
        content: [
          { type: "text", text: `${index}: synthetic tool result `.padEnd(resultBytes, "x") },
        ],
        details: { files: [{ path: `synthetic-${index}.txt`, lines: [1, 2, 3] }] },
        isError: false,
      },
    })),
  ],
  version: { generation: "synthetic", rawSeq: entries, updatedAt: 1 },
};
const manager = new ReloadManager("/synthetic");
const historyHash = hash("sha256", JSON.stringify(fixture.events.slice(1)));
let expectedContext: string | undefined;
const times: number[] = [];
const cpu: number[] = [];
const allocations: number[] = [];
const inspector = new Session();
const hostBefore = loadavg();
for (let iteration = -2; iteration < operations; iteration++) {
  // Structured clone models receiver ownership; omit transport cost from the owner measurement.
  const snapshot = structuredClone(fixture);
  await setImmediate();
  globalThis.gc();
  if (values.allocation && iteration >= 0) {
    await startCollectedHeapSampling(inspector, 32768);
  }
  const beforeCpu = process.threadCpuUsage();
  const beforeTime = performance.now();
  freezeTranscriptSnapshot(snapshot);
  manager.adopt({ kind: "full", snapshot });
  const branch = manager[sessionManagerReadTranscriptBranch]();
  const context = buildInitialContext(branch);
  const elapsed = performance.now() - beforeTime;
  const used = process.threadCpuUsage(beforeCpu);
  if (iteration >= 0) {
    times.push(elapsed);
    cpu.push((used.user + used.system) / 1000);
  }
  if (values.allocation && iteration >= 0) {
    allocations.push(
      sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head),
    );
    inspector.disconnect();
  }
  assert.equal(hash("sha256", JSON.stringify(branch)), historyHash);
  const contextHash = hash("sha256", JSON.stringify(context));
  expectedContext ??= contextHash;
  assert.equal(contextHash, expectedContext);
}
const sorted = times.toSorted((a, b) => a - b);
writeFileSync(
  values.output,
  JSON.stringify(
    {
      node: process.version,
      operations,
      entries,
      resultBytes,
      scope: "main-thread freeze, reload adoption and initial context; no SQL or transport",
      ownerHash: hash("sha256", readFileSync(values["owner-file"] ?? ownerUrl)),
      historyHash,
      contextHash: expectedContext,
      cpuMsPerOperation: cpu.reduce((sum, value) => sum + value, 0) / operations,
      p50Ms: sorted[Math.ceil(operations * 0.5) - 1],
      p95Ms: sorted[Math.ceil(operations * 0.95) - 1],
      maxTaskMs: sorted.at(-1),
      sampledBytesPerOperation: allocations.length
        ? allocations.reduce((sum, value) => sum + value, 0) / operations
        : undefined,
      times,
      cpu,
      hostBefore,
      hostAfter: loadavg(),
    },
    null,
    2,
  ) + "\n",
);
