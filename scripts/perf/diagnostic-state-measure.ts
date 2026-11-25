/**
 * Synthetic per-steer diagnostic lifecycle measurement; no Gateway, database or workspace I/O.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/diagnostic-state-measure.ts \
 *   --output <new-directory> [--baseline-dir <sparse-source-overlay> --expected-state idle]
 * Use four unchanged A/A runs, then five interleaved baseline/candidate pairs.
 * Repeat separately with --allocation or --cpu-profile; exclude profiled timings.
 * Acceptance: active exec stays processing, queued counts stay exact; report any CPU,
 * latency or allocation growth. This is a correctness repair, not a speedup claim.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    "expected-state": { type: "string", default: "processing" },
    iterations: { type: "string", default: "100000" },
    sessions: { type: "string", default: "4096" },
    allocation: { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
assert(globalThis.gc, "Run with --expose-gc");
assert(["idle", "processing"].includes(values["expected-state"]));
const iterations = Number(values.iterations);
const sessions = Number(values.sessions);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(sessions) && sessions >= 2000);
const output = path.resolve(values.output);
mkdirSync(output);
const configPath = path.join(output, "openclaw.json");
writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
process.env = createGatewayBenchEnv(output, configPath, { startupTrace: false });
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const repository = fileURLToPath(new URL("../../", import.meta.url));
const owners = ["src/logging/diagnostic-runtime.ts", "src/logging/message-lifecycle.ts"];
const sourceHashes = Object.fromEntries(
  owners.map((owner) => [
    owner,
    createHash("sha256")
      .update(readFileSync(path.join(values["baseline-dir"] ?? repository, owner)))
      .digest("hex"),
  ]),
);
const { setDiagnosticsEnabledForProcess, waitForDiagnosticEventsDrained } =
  await import("../../src/infra/diagnostic-events.js");
const { getDiagnosticSessionState, diagnosticSessionStates } =
  await import("../../src/logging/diagnostic-session-state.js");
const { createDiagnosticMessageLifecycle } = await import("../../src/logging/message-lifecycle.js");
const { getDiagnosticSessionActivitySnapshot } =
  await import("../../src/logging/diagnostic-run-activity.js");
const { createReplyOperation } = await import("../../src/sessions/session-controller.operation.js");
const { reserveSessionControllerSource, retireSessionControllerInput } =
  await import("../../src/sessions/session-controller.mailbox.js");

setDiagnosticsEnabledForProcess(true);
const residents = Array.from({ length: sessions }, (_, index) =>
  reserveSessionControllerSource(`agent:main:diagnostic-resident-${index}`, {
    policy: { mode: "steer" },
  }),
);
for (let index = 0; index < 1999; index++) {
  getDiagnosticSessionState({
    sessionKey: `agent:main:diagnostic-resident-${index}`,
    sessionId: `resident-${index}`,
  });
}
const ref = { sessionKey: "agent:main:measured-exec", sessionId: "measured-exec" };
const createMessage = () =>
  createDiagnosticMessageLifecycle({
    ...ref,
    enabled: true,
    channel: "synthetic",
    source: "dispatch",
    trackSessionState: true,
  });
const message = createMessage();
message.markProcessing();
const operation = createReplyOperation({ ...ref, resetTriggered: false });
operation.setPhase("running");
const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
const finishTool = attempt.beginTool({
  toolName: "exec",
  toolCallId: "held-exec",
  deadlineAtMs: Date.now() + 600_000,
});
message.markProcessing(); // A pending input remains queued throughout the measured dispatches.
const state = getDiagnosticSessionState(ref);
const dispatch = () => {
  const steer = createMessage();
  steer.markProcessing();
  steer.markIdle("message_completed");
};
for (let index = 0; index < 10000; index++) {
  dispatch();
}
await waitForDiagnosticEventsDrained();
assert.equal(diagnosticSessionStates.size, 2000);
assert.equal(getDiagnosticSessionActivitySnapshot(ref).activeToolName, "exec");
assert.equal(state.state, values["expected-state"]);
assert.equal(state.queueDepth, 2);
globalThis.gc();

const inspector = values.allocation || values["cpu-profile"] ? new Session() : undefined;
if (values.allocation) {
  await startCollectedHeapSampling(inspector!, 32768);
} else if (inspector) {
  inspector.connect();
}
if (values["cpu-profile"]) {
  await inspector!.post("Profiler.enable");
  await inspector!.post("Profiler.start");
}
const hostLoad = { before: loadavg(), after: [] as number[] };
const samples = new Float64Array(iterations);
const cpu = process.cpuUsage();
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  const before = performance.now();
  dispatch();
  samples[index] = performance.now() - before;
  assert.equal(state.state, values["expected-state"]);
  assert.equal(state.queueDepth, 2);
}
const elapsedMs = performance.now() - started;
const usage = process.cpuUsage(cpu);
hostLoad.after = loadavg();
let sampledAllocatedBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector!.post("HeapProfiler.stopSampling");
  sampledAllocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  writeFileSync(path.join(output, "allocation.heapprofile"), JSON.stringify(profile));
}
if (values["cpu-profile"]) {
  const { profile } = await inspector!.post("Profiler.stop");
  writeFileSync(path.join(output, "cpu.cpuprofile"), JSON.stringify(profile));
}
inspector?.disconnect();
const sorted = samples.toSorted();
const result = {
  node: process.version,
  sessions,
  diagnosticStates: diagnosticSessionStates.size,
  iterations,
  sourceHashes,
  expectedState: values["expected-state"],
  allocation: values.allocation,
  cpuProfile: values["cpu-profile"],
  elapsedMs,
  cpuMs: (usage.user + usage.system) / 1000,
  sampledAllocatedBytes,
  dispatchMs: {
    p50: sorted[Math.ceil(iterations * 0.5) - 1],
    p95: sorted[Math.ceil(iterations * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  },
  counts: { dispatches: iterations, matchingStates: iterations, exactQueueCounts: iterations },
  samples: [...samples],
  hostLoad,
  limitations:
    "In-memory owner only: no database, workspace, btrfs, transport, model, or tool process. The real controller records an outstanding exec; no wall-clock tool wait is measured.",
};
writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, samples: undefined }));
finishTool();
message.markIdle("message_completed");
operation.complete();
for (const input of residents) {
  retireSessionControllerInput(input);
}
await Promise.all(residents.map((input) => input.settlement.promise));
