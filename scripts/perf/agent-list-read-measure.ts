/**
 * Warm agent-list owner read, with real state-reader transport and committed deletion facts.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-list-read-measure.ts \
 *   --state-dir "$PWD/.local/agent-list-measure" --iterations 2000 --mode timing
 * Repeat with --mode allocation; --owner accepts an adjacent baseline agent-list.ts copy.
 * Run baseline/candidate in separate processes in AB/BA order. Fixture: 40 configured
 * agents, registered store paths, and one retained deletion. No Gateway latency claim.
 * Acceptance: identical response digest, zero repeated discovery requests, lower CPU
 * or allocation without a repeatable latency regression. Timing is untraced; allocation
 * includes collected objects. Output records per-call tails, samples, CPU and host load.
 * --enriched measures listAgentsForGateway (including permission/model/avatar projection)
 * instead of the basic roster; --sandbox all|off selects the global sandbox posture.
 * For that mode --owner accepts an adjacent baseline session-utils-store.ts copy.
 * Use a fresh state directory per process (the fixture retains a deletion tombstone).
 * --mode cpu-profile --profile-output <file> captures a separate attribution pass;
 * allocation mode also accepts --profile-output. CPU for decisions comes from timing mode.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
    mode: { type: "string", default: "timing" },
    enriched: { type: "boolean", default: false },
    sandbox: { type: "string", default: "off" },
    "profile-output": { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name isolated synthetic state");
assert(values.mode === "timing" || values.mode === "allocation" || values.mode === "cpu-profile");
assert(values.mode !== "cpu-profile" || values["profile-output"]);
assert(values.sandbox === "all" || values.sandbox === "off");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values["state-dir"]);
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
mkdirSync(root, { recursive: true });
const owner = values.owner ? pathToFileURL(path.resolve(values.owner)).href : undefined;
const listAgents = values.enriched
  ? (
      (await import(
        owner ?? "../../src/gateway/session-utils-store.js"
      )) as typeof import("../../src/gateway/session-utils-store.js")
    ).listAgentsForGateway
  : (
      (await import(
        owner ?? "../../src/gateway/agent-list.js"
      )) as typeof import("../../src/gateway/agent-list.js")
    ).listGatewayAgentsBasic;
const { runOpenClawStateWriteTransaction, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.js");
const { registerOpenClawAgentDatabase } =
  await import("../../src/state/openclaw-agent-db-registry.js");
const { beginAgentDeletionJournalInDatabase } =
  await import("../../src/state/agent-deletion-journal.js");
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: {
      sandbox: { mode: values.sandbox },
      model: { primary: "openai/gpt-4.1-mini" },
      workspace: path.join(root, "workspace"),
    },
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`worker-${String(i).padStart(2, "0")}`, {}]),
    ),
  },
};
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(cfg);
for (const agentId of Object.keys(cfg.agents!.entries!)) {
  const dir = path.join(root, "agents", agentId);
  mkdirSync(dir, { recursive: true });
  registerOpenClawAgentDatabase({ agentId, path: path.join(dir, "openclaw-agent.sqlite") });
}
runOpenClawStateWriteTransaction((database) => {
  beginAgentDeletionJournalInDatabase(database, {
    agentId: "worker-39",
    operationId: "synthetic-retirement",
    agentDir: path.join(root, "agents", "worker-39"),
    workspaceDir: path.join(root, "workspace"),
    sessionsDir: path.join(root, "agents", "worker-39", "sessions"),
    deleteFiles: false,
  });
});
const inspector = new Session();
const allocationBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + allocationBytes(child), 0);
try {
  const golden = JSON.stringify(await listAgents(cfg));
  assert.equal(JSON.parse(golden).agents.length, 39);
  for (let i = 0; i < 20; i++) {
    await listAgents(cfg);
  }
  const { onWorkerRequestMetrics } = await import("../../src/infra/worker-request-diagnostics.js");
  const workerRequests: Record<string, number> = {};
  const stopObserving = onWorkerRequestMetrics((kind, requestClass, phase) => {
    if (phase === "completed") {
      const key = `${kind}:${requestClass}`;
      workerRequests[key] = (workerRequests[key] ?? 0) + 1;
    }
  });
  await listAgents(cfg);
  stopObserving();
  global.gc?.();
  const beforeLoad = loadavg();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else if (values.mode === "cpu-profile") {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const latencies: number[] = [];
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await listAgents(cfg);
    latencies.push(performance.now() - start);
  }
  const used = process.cpuUsage(cpu);
  const mainThread = process.threadCpuUsage(threadCpu);
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  if (profile && values["profile-output"]) {
    writeFileSync(values["profile-output"], JSON.stringify(profile));
  }
  if (values.mode === "cpu-profile") {
    writeFileSync(
      values["profile-output"]!,
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
  }
  assert.equal(JSON.stringify(await listAgents(cfg)), golden);
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      mode: values.mode,
      iterations,
      agents: 40,
      enriched: values.enriched,
      sandbox: values.sandbox,
      digest: createHash("sha256").update(golden.replaceAll(root, "/synthetic")).digest("hex"),
      cpuUsPerCall: (used.user + used.system) / iterations,
      mainThreadCpuUsPerCall: (mainThread.user + mainThread.system) / iterations,
      allocationBytesPerCall: profile ? allocationBytes(profile.head) / iterations : undefined,
      workerRequestsPerCall: workerRequests,
      p50Ms: latencies[Math.floor(iterations * 0.5)],
      p99Ms: latencies[Math.floor(iterations * 0.99)],
      hostLoad: { before: beforeLoad, after: loadavg() },
    }),
  );
} finally {
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
}
