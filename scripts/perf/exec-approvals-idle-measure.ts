/**
 * Warm approval initialization polls through the real host and SQLite workers.
 * Run on each revision with synthetic state only:
 * node --import ./scripts/tsx.mjs scripts/perf/exec-approvals-idle-measure.ts \
 *   --iterations 2000 --mode timing
 * Repeat with --mode allocation; inspector samples include collected objects.
 * The 40-agent/800-entry policy matches the exec receipt census. Eighteen polls
 * represent one simulated idle minute; no command is executed. Measures main
 * isolate CPU/allocation, writer request counts, and unchanged persisted bytes.
 * Credential-worker work is included in elapsed time, not main-isolate CPU.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  ensureExecApprovalsSnapshot,
  readExecApprovalsSnapshot,
  updateExecApprovalsForMaintenance,
} from "../../src/infra/exec-approvals-store.js";
import { onWorkerRequestMetrics } from "../../src/infra/worker-request-diagnostics.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    mode: { type: "string", default: "timing" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
mkdirSync(".local", { recursive: true });
const stateDir = mkdtempSync(path.resolve(".local/exec-approvals-idle-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
// macOS app IPC follows the profile independently of OPENCLAW_STATE_DIR.
process.env.OPENCLAW_PROFILE = path.basename(stateDir).toLowerCase();
const inspector = new Session();
let requests = 0;
const stop = onWorkerRequestMetrics((kind, requestClass, phase) => {
  if (kind === "sqlite_writer" && requestClass === "execApprovals" && phase === "queued") {
    requests++;
  }
});
function allocationBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocationBytes(child), 0);
}
try {
  updateExecApprovalsForMaintenance(() => ({
    version: 1,
    agents: Object.fromEntries(
      Array.from({ length: 40 }, (_, agent) => [
        agent === 0 ? "main" : `synthetic-agent-${agent}`,
        {
          allowlist: Array.from({ length: 20 }, (_entry, entry) => ({
            id: `synthetic-${entry}`,
            pattern: `/usr/bin/synthetic-${entry}`,
          })),
        },
      ]),
    ),
  }));
  const initial = await ensureExecApprovalsSnapshot();
  for (let warm = 0; warm < 10; warm++) {
    await ensureExecApprovalsSnapshot();
  }
  requests = 0;
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    const snapshot = await ensureExecApprovalsSnapshot();
    assert.equal(snapshot.hash, initial.hash);
  }
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const allocated =
    values.mode === "allocation"
      ? allocationBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
  assert.equal(readExecApprovalsSnapshot().raw, initial.raw);
  console.log(
    JSON.stringify({
      iterations,
      mode: values.mode,
      policyBytes: Buffer.byteLength(initial.raw!),
      writerRequests: requests,
      requestsPerSimulatedIdleMinute: (requests * 18) / iterations,
      mainCpuMs: (used.user + used.system) / 1000,
      elapsedMs,
      allocatedBytesPerOp: allocated === undefined ? undefined : allocated / iterations,
      hostLoad: loadavg(),
    }),
  );
} finally {
  inspector.disconnect();
  stop();
  await closeOpenClawStateDatabaseAsync();
  rmSync(stateDir, { recursive: true, force: true });
}
