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
 * --cold reads each selected session once without warming its branch summary; use
 * --cold-summary after worker-cold-fixture.ts for real archive restoration. Restore
 * a fresh synthetic fixture copy for each run. --offset chooses a disjoint cohort.
 * --base-list-file substitutes the branch-list owner. Run A/A then ABABA/BABAB,
 * at least five samples per arm; compare cold separately from --steady warm reads.
 * --profile-prefix writes CPU profiles, or heap profiles with --allocations, for
 * the main isolate and workers. Profile runs are separate from timing runs.
 * Cold acceptance: identical response checksums, one cold refusal per restoration
 * instead of two, lower total work, and no material warm-path regression.
 * --signal supplies an independent request signal for each accessor call, matching
 * RPC cancellation ownership without adding timer overhead to the owner timing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayBenchWorkerProfiler } from "../lib/gateway-bench-worker-profile.ts";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    "base-file": { type: "string" },
    "base-list-file": { type: "string" },
    iterations: { type: "string" },
    offset: { type: "string", default: "0" },
    cold: { type: "boolean" },
    "cold-summary": { type: "boolean" },
    "profile-prefix": { type: "string" },
    signal: { type: "boolean" },
    allocations: { type: "boolean" },
    steady: { type: "boolean" },
  },
});
assert(values.root, "--root must name an offline synthetic fixture");
const root = path.resolve(values.root);
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
assert(fixture.sessionCount >= 10000);
const cold = Boolean(values.cold || values["cold-summary"]);
assert(!cold || !values.steady, "--cold and --steady select different workloads");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: cold ? 32 : 2048,
  min: 1,
  label: "iterations",
});
const offset = parseStrictIntegerOption({
  raw: values.offset,
  fallback: 0,
  min: 0,
  label: "offset",
});
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const owner = new URL(
  "../../src/config/sessions/session-accessor.sqlite-branches.ts",
  import.meta.url,
).href;
const wasOwnerReplaced = registerPerfOwnerReplacement(owner, values["base-file"]);
const wasListOwnerReplaced = registerPerfOwnerReplacement(
  new URL("../../src/config/sessions/session-accessor.sqlite-branch-list.ts", import.meta.url).href,
  values["base-list-file"],
);
let branchRequests = 0;
let coldRefusals = 0;
const workers = new Set<Worker>();
const workerChannel = channel("worker_threads");
const observeReply = (message: unknown) => {
  if (
    isRecord(message) &&
    message.status === "ok" &&
    isRecord(message.value) &&
    message.value.ok === false &&
    isRecord(message.value.error) &&
    message.value.error.kind === "cold"
  ) {
    coldRefusals++;
  }
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
assert(
  !values["base-list-file"] || wasListOwnerReplaced(),
  "Baseline list owner was not substituted",
);
const coldSummary = values["cold-summary"]
  ? JSON.parse(readFileSync(path.join(root, "worker-cold-summary.json"), "utf8"))
  : undefined;
if (coldSummary) {
  assert.equal(coldSummary.format, "openclaw-worker-cold-fixture-v1");
  assert(offset + iterations <= coldSummary.sessionKeys.length, "cold cohort exceeds archive keys");
}
assert(offset + (cold ? iterations : 32) < fixture.sessionCount, "cohort exceeds fixture sessions");
const scopes = Array.from({ length: cold ? iterations : 32 }, (_, index) => ({
  agentId: "main",
  sessionKey:
    coldSummary?.sessionKeys[offset + index] ??
    `agent:main:team-shape-session-${offset + index + 1}`,
}));
const expected: string[] = [];
const inspector = new Session();
const profilePrefix = values["profile-prefix"] && path.resolve(values["profile-prefix"]);
const profiler = profilePrefix ? new GatewayBenchWorkerProfiler(inspector) : undefined;
const profileKind = values.allocations ? "heap" : "cpu";
// Inspector worker requests do not keep a standalone benchmark's event loop alive.
const profileLifetime = profilePrefix ? setInterval(() => undefined, 1_000) : undefined;
try {
  for (const scope of cold ? [] : scopes) {
    const result = await listSessionBranches(scope);
    assert.equal(result.status, "ok");
    expected.push(JSON.stringify(result));
  }
  assert(cold || branchRequests > 0, "Worker reply instrumentation did not observe warmup");
  branchRequests = 0;
  coldRefusals = 0;
  globalThis.gc?.();
  if (values.allocations || profilePrefix) {
    inspector.connect();
  }
  if (profilePrefix) {
    await profiler!.start(profileKind, profilePrefix, { samplingIntervalBytes: 4096 });
  }
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else if (profilePrefix) {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const checksum = createHash("sha256");
  const samples: number[] = [];
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpuStart = process.threadCpuUsage();
  const processCpuStart = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    const selected = index % scopes.length;
    if (selected === 0 && !values.steady && !cold) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:team-shape-session-9999" },
        { sessionId: "team-shape-session-9999", updatedAt: Date.now() },
      );
    }
    const before = performance.now();
    const result = await listSessionBranches({
      ...scopes[selected]!,
      ...(values.signal ? { signal: new AbortController().signal } : {}),
    });
    samples.push(performance.now() - before);
    const bytes = JSON.stringify(result);
    assert.equal(result.status, "ok");
    if (!cold) {
      assert.equal(bytes, expected[selected]);
    }
    checksum.update(bytes);
  }
  const cpu = process.threadCpuUsage(cpuStart);
  const processCpu = process.cpuUsage(processCpuStart);
  const wallMs = performance.now() - start;
  const memoryAfter = process.memoryUsage();
  const heap = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  const allocatedBytes = heap && sumSampledHeapBytes(heap.head);
  if (profilePrefix) {
    const profile = heap ?? (await inspector.post("Profiler.stop")).profile;
    writeFileSync(
      `${profilePrefix}.${values.allocations ? "heapprofile" : "cpuprofile"}`,
      JSON.stringify(profile),
    );
    await profiler!.stop(profileKind);
  }
  assert(!coldSummary || coldRefusals >= iterations, "selected transcripts were not cold");
  const firstCallMs = samples[0];
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      baseline: Boolean(values["base-file"] || values["base-list-file"]),
      cold,
      restored: Boolean(coldSummary),
      offset,
      steady: Boolean(values.steady),
      mode: values.allocations ? "allocation" : profilePrefix ? "cpu-profile" : "timing",
      iterations,
      sessions: fixture.sessionCount,
      branchRequests,
      coldRefusals,
      branchWorkerAttempts: branchRequests + coldRefusals,
      independentRequestSignals: Boolean(values.signal),
      gitProcesses: 0,
      checksum: checksum.digest("hex"),
      cpuMs: (cpu.user + cpu.system) / 1000,
      processCpuMs: (processCpu.user + processCpu.system) / 1000,
      wallMs,
      allocatedBytes,
      allocationScope: "main-isolate",
      workerProfiles: profilePrefix ? `${profilePrefix}.workers.json` : undefined,
      latencyMs: {
        count: samples.length,
        first: firstCallMs,
        p50: samples[Math.ceil(samples.length * 0.5) - 1],
        p90: samples[Math.ceil(samples.length * 0.9) - 1],
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
  clearInterval(profileLifetime);
  inspector.disconnect();
  workerChannel.unsubscribe(observeWorker);
  for (const worker of workers) {
    worker.off("message", observeReply);
  }
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
