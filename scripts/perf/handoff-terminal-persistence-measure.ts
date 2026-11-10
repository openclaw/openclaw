// Synthetic owner benchmark (no database/workspace I/O or model calls).
// node --import ./scripts/tsx.mjs scripts/perf/handoff-terminal-persistence-measure.ts \
//   --source-root <checkout> --mode refusal --label A --sessions 10800 --iterations 20
// Run fresh processes in A/A and interleaved A/B order; setup/import time is excluded.
// Acceptance: unchanged idle path; finishing writes succeed within the original drain
// budget; leaks stay refused. Diagnostic/wait overhead is reported, not called a speedup.
// Storage size is outside this in-memory boundary; no 35-GiB/btrfs claim is made.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { RpcSourceRef } from "../../src/sessions/session-controller.rpc-sources.types.js";

const { values } = parseArgs({
  options: {
    "source-root": { type: "string", default: process.cwd() },
    mode: { type: "string", default: "refusal" },
    label: { type: "string", default: "candidate" },
    sessions: { type: "string", default: "10800" },
    iterations: { type: "string", default: "20" },
  },
});
const count = Number(values.sessions);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(count) && count >= 10);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["idle", "refusal", "settlement"].includes(values.mode));
const root = path.resolve(values["source-root"]);
const source = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const coordinator: typeof import("../../src/infra/gateway-suspend-coordinator.js") = await source(
  "src/infra/gateway-suspend-coordinator.ts",
);
const mailbox: typeof import("../../src/sessions/session-controller.mailbox.js") = await source(
  "src/sessions/session-controller.mailbox.ts",
);
const lifecycle: typeof import("../../src/sessions/session-controller.lifecycle.js") = await source(
  "src/sessions/session-controller.lifecycle.ts",
);
const rpc: typeof import("../../src/sessions/session-controller.rpc-sources.js") = await source(
  "src/sessions/session-controller.rpc-sources.ts",
);
const activity: typeof import("../../src/gateway/server-active-work.js") = await source(
  "src/gateway/server-active-work.ts",
);
const terminal: typeof import("../../src/gateway/server-runtime-terminal-tracking.js") =
  await source("src/gateway/server-runtime-terminal-tracking.ts");
const sources: RpcSourceRef[] = [];
for (let index = 0; index < count; index++) {
  const runId = `synthetic-run-${index}`;
  const target = lifecycle.captureSessionTarget({
    storeScope: "/synthetic/handoff-benchmark/sessions",
    sessionKey: `agent:synthetic:session-${index}`,
    incarnation: `session-${index}`,
  });
  const adapter = { controlUiVisible: true };
  const input = mailbox.reserveSessionControllerSource(target.sessionKey, {
    target,
    adapter,
    protocolRunId: runId,
    sourceSessionId: `session-${index}`,
    policy: { mode: "followup" },
  });
  const ref = { input, adapter };
  rpc.registerRpcSource(runId, ref);
  sources.push(ref);
}
const inspect = activity.createGatewayServerActiveWorkInspectors({ cron: {} });
const lease = coordinator.prepareGatewaySuspend({
  requestId: "synthetic-handoff-benchmark",
  drain: true,
  inspect,
  pauseScheduling() {},
  resumeScheduling() {},
});
assert(lease.status === "ready");
const writes = Array.from({ length: values.mode === "idle" ? 0 : 10 }, () =>
  Promise.withResolvers<void>(),
);
const tracking = terminal.createGatewayTerminalTracking({ getScopedRpcSource: rpc.getRpcSource });
for (const [index, write] of writes.entries()) {
  const runId = `synthetic-run-${index}`;
  sources[index]!.adapter.projectSessionTerminalObservedAt = Date.now();
  assert(
    tracking.trackTrackedRunTerminalPersistence({
      runId,
      clientRunId: runId,
      persistence: write.promise,
    }),
  );
}
const owner = { isCurrent: () => true };
const arm = () => coordinator.armGatewaySuspendHandoff({ suspensionId: lease.suspensionId, owner });
// Warm the actual owner, including redaction, before measuring allocation and CPU.
const request = coordinator.requestGatewaySuspendHandoff;
const handoff = () =>
  typeof request === "function"
    ? request({ suspensionId: lease.suspensionId, owner, assertCurrent() {} })
    : arm();
for (let index = 0; index < 5; index++) {
  const result = values.mode === "idle" ? await handoff() : arm();
  assert.equal(result.ok, values.mode === "idle");
}
const profiler = new Session();
profiler.connect();
await profiler.post("HeapProfiler.startSampling", {
  samplingInterval: 4096,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
const cpu = process.cpuUsage();
const started = performance.now();
let accepted = 0;
let responseBytes = 0;
if (values.mode !== "settlement") {
  for (let index = 0; index < iterations; index++) {
    const result = values.mode === "idle" ? await handoff() : arm();
    accepted += Number(result.ok);
    responseBytes = Buffer.byteLength(JSON.stringify(result));
  }
} else {
  const settlement = setTimeout(() => writes.forEach((write) => write.resolve()), 100);
  accepted = Number((await handoff()).ok);
  clearTimeout(settlement);
}
const elapsedMs = performance.now() - started;
const cpuUsed = process.cpuUsage(cpu);
const { profile } = await profiler.post("HeapProfiler.stopSampling");
profiler.disconnect();
const allocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
console.log(
  JSON.stringify({
    label: values.label,
    mode: values.mode,
    sources: count,
    pendingWrites: writes.length,
    iterations: values.mode !== "settlement" ? iterations : 1,
    elapsedMs,
    cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    allocatedBytes,
    accepted,
    responseBytes,
    load: loadavg(),
  }),
);
writes.forEach((write) => write.resolve());
coordinator.resumeGatewaySuspend(lease.suspensionId);
sources.forEach((ref) => mailbox.retireSessionControllerInput(ref.input));
await Promise.all(sources.map((ref) => ref.input.settlement.promise));
