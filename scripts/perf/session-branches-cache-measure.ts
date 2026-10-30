/**
 * Branch-list owner proof on offline synthetic Team-shaped storage (never live state).
 * Seed: scripts/perf/team-shape-fixture.ts --state-dir .local/branches --sessions 10000
 * --runs 0 --cron 0 --approvals 0 --projects 0 --transcript-mib 1.
 * Run: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/session-branches-cache-measure.ts --root .local/branches --iterations 2048
 * --base-file <saved-session-accessor.sqlite-branches.ts> substitutes the cache owner.
 * Run alternating base/candidate timing passes, then separate --allocations passes.
 * Each cohort reads 32 sessions after a real unrelated session write; --steady omits
 * writes as a warm-cache control. CPU/allocation includes the identical write workload;
 * per-call latency excludes writes. Counts observe completed worker round trips.
 * Acceptance: identical response checksums, fewer branch-worker requests, lower main
 * thread CPU/allocation under churn, no material warm-cache regression. No Git is used.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    "base-file": { type: "string" },
    iterations: { type: "string", default: "2048" },
    allocations: { type: "boolean" },
    steady: { type: "boolean" },
  },
});
assert(values.root, "--root must name an offline synthetic fixture");
const root = path.resolve(values.root);
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
assert(fixture.sessionCount >= 10000);
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2048,
  min: 1,
  label: "iterations",
});
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const owner = new URL(
  "../../src/config/sessions/session-accessor.sqlite-branches.ts",
  import.meta.url,
).href;
const wasOwnerReplaced = registerPerfOwnerReplacement(owner, values["base-file"]);
let branchRequests = 0;
const workers = new Set<Worker>();
const workerChannel = channel("worker_threads");
const observeReply = (message: unknown) => {
  if (
    isRecord(message) &&
    message.status === "ok" &&
    isRecord(message.value) &&
    message.value.ok === true &&
    isRecord(message.value.value) &&
    message.value.value.kind === "branch-summaries"
  ) {
    branchRequests++;
  }
};
const observeWorker = (message: unknown) => {
  assert(isRecord(message) && message.worker instanceof Worker);
  workers.add(message.worker);
  message.worker.on("message", observeReply);
};
workerChannel.subscribe(observeWorker);
const { listSessionBranches, upsertSessionEntryCore } =
  await import("../../src/config/sessions/session-accessor.js");
const agentDb = await import("../../src/state/openclaw-agent-db.js");
const stateDb = await import("../../src/state/openclaw-state-db.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")));
assert(!values["base-file"] || wasOwnerReplaced(), "Baseline owner was not substituted");
const scopes = Array.from({ length: 32 }, (_, index) => ({
  agentId: "main",
  sessionKey: `agent:main:team-shape-session-${index + 1}`,
}));
const expected: string[] = [];
const inspector = new Session();
try {
  for (const scope of scopes) {
    const result = await listSessionBranches(scope);
    assert.equal(result.status, "ok");
    expected.push(JSON.stringify(result));
  }
  assert(branchRequests > 0, "Worker reply instrumentation did not observe warmup");
  branchRequests = 0;
  globalThis.gc?.();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const checksum = createHash("sha256");
  const samples: number[] = [];
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    const selected = index % scopes.length;
    if (selected === 0 && !values.steady) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:team-shape-session-9999" },
        { sessionId: "team-shape-session-9999", updatedAt: Date.now() },
      );
    }
    const before = performance.now();
    const result = await listSessionBranches(scopes[selected]!);
    samples.push(performance.now() - before);
    const bytes = JSON.stringify(result);
    assert.equal(bytes, expected[selected]);
    checksum.update(bytes);
  }
  const cpu = process.threadCpuUsage(cpuStart);
  const wallMs = performance.now() - start;
  const memoryAfter = process.memoryUsage();
  const allocatedBytes = values.allocations
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      baseline: Boolean(values["base-file"]),
      steady: Boolean(values.steady),
      mode: values.allocations ? "allocation" : "timing",
      iterations,
      sessions: fixture.sessionCount,
      branchRequests,
      gitProcesses: 0,
      checksum: checksum.digest("hex"),
      cpuMs: (cpu.user + cpu.system) / 1000,
      wallMs,
      allocatedBytes,
      latencyMs: {
        count: samples.length,
        p50: samples[Math.ceil(samples.length * 0.5) - 1],
        p99: samples[Math.ceil(samples.length * 0.99) - 1],
        max: samples.at(-1),
      },
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  inspector.disconnect();
  workerChannel.unsubscribe(observeWorker);
  for (const worker of workers) {
    worker.off("message", observeReply);
  }
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
