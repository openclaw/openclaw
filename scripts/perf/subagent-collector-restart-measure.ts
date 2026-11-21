/**
 * Offline completion recovery on a synthetic Team fixture (never use live state).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-collector-restart-measure.ts \
 *   --fixture /absolute/synthetic-fixture --output /absolute/result.json \
 *   [--source /absolute/restore-metadata.base.ts] [--control] [--allocation]
 *   [--shutdown-completions]
 * Interleave A/A/B processes, at least five each. Imports, fixture reset and compact
 * hydration are outside timing; restore metadata includes its real worker commit.
 * Acceptance: all 16 interrupted collectors become waitable; completed-cohort controls
 * retain their results without a consistent timing/CPU/allocation regression.
 * Shutdown mode instead requires all 16 legacy quiet kills to retain deliverable errors;
 * compare its already-repaired controls separately from the required one-time writes.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    source: { type: "string" },
    control: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    "shutdown-completions": { type: "boolean", default: false },
  },
});
assert(values.fixture && values.output && global.gc, "Pass --fixture, --output and --expose-gc");
const fixture = path.resolve(values.fixture);
const summary = JSON.parse(readFileSync(path.join(fixture, "team-shape-summary.json"), "utf8"));
assert(
  summary.format === "openclaw-team-shape-v1" && summary.sessionCount >= 10_800,
  "Requires the generated synthetic Team fixture",
);
process.env.OPENCLAW_HOME = fixture;
process.env.OPENCLAW_STATE_DIR = fixture;
process.env.OPENCLAW_CONFIG_PATH = path.join(fixture, "openclaw.json");
const owner = new URL(
  "../../src/agents/subagents/registry/subagent-registry-restore-metadata.ts",
  import.meta.url,
);
const source = readFileSync(values.source ?? owner, "utf8");
let loaded = false;
registerHooks({
  load(url, context, next) {
    if (url === owner.href) {
      loaded = true;
      return { format: "module-typescript", source, shortCircuit: true };
    }
    return next(url, context);
  },
});
const { captureRuntimeConfigAsyncReader } = await import("../../src/config/config.js");
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.js");
const { restoreSubagentRunMetadata } =
  await import("../../src/agents/subagents/registry/subagent-registry-restore-metadata.js");
const { restoreSubagentRunsFromDisk } =
  await import("../../src/agents/subagents/registry/subagent-registry-persistence.js");
const { saveSubagentRegistryToSqlite } =
  await import("../../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js");
const { captureOpenClawStateWorkerContext } =
  await import("../../src/state/openclaw-state-worker-context.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
assert(loaded, "Requested owner was not loaded");
await captureRuntimeConfigAsyncReader()();
const now = Date.now();
const rows = new Map<string, SubagentRunRecord>();
for (let i = 0; i < 4300; i++) {
  const interrupted = i < 16;
  const runId = `collector-${i}`;
  rows.set(runId, {
    runId,
    childAgentId: "main",
    childSessionKey: `agent:main:subagent:${runId}`,
    childSessionIdentity: { sessionId: runId, lifecycleRevision: runId },
    requesterAgentId: "main",
    requesterSessionKey: `agent:main:dashboard:synthetic-${Math.floor(i / 2)}`,
    requesterDisplayKey: "Synthetic requester",
    task: `Synthetic collector ${i}`,
    cleanup: "keep",
    createdAt: now - 1000,
    collect: true,
    expectsCompletionMessage: false,
    execution: {
      status: "terminal",
      startedAt: now - 1000,
      endedAt: now - 500,
      suppressSessionEffects: true,
      outcome: interrupted ? { status: "error", error: "Gateway stopped" } : { status: "ok" },
    },
    endedReason: interrupted ? "subagent-killed" : "subagent-complete",
    completion: {
      required: false,
      resultText: interrupted ? undefined : "Synthetic captured result",
    },
    delivery: { status: "not_required" },
    collectorCompletion:
      interrupted && !values.control ? undefined : { status: interrupted ? "killed" : "done" },
    archiveAtMs: now - 500 + 86_400_000,
  });
  if (values["shutdown-completions"] && interrupted) {
    Object.assign(rows.get(runId)!, {
      collect: undefined,
      collectorCompletion: undefined,
      spawnMode: "run",
      expectsCompletionMessage: true,
      endedReason: values.control ? "subagent-error" : "subagent-killed",
      completion: {
        required: true,
        ...(values.control ? { resultText: null, capturedAt: now - 500 } : {}),
      },
      delivery: { status: "pending" },
      cleanupHandled: !values.control,
      cleanupCompletedAt: values.control ? undefined : now - 500,
      suppressAnnounceReason: values.control ? undefined : "killed",
      killReconciliation: values.control
        ? undefined
        : { killedAt: now - 500, suppressTaskDelivery: true },
      archiveAtMs: undefined,
    });
  }
}
const inspector = new Session();
inspector.connect();
const trials = [];
try {
  for (let trial = 0; trial < 6; trial++) {
    subagentRuns.clear();
    saveSubagentRegistryToSqlite(rows);
    await restoreSubagentRunsFromDisk({ runs: subagentRuns });
    const context = captureOpenClawStateWorkerContext();
    global.gc();
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    if (values.profile) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    const cpu = process.cpuUsage();
    const start = performance.now();
    await restoreSubagentRunMetadata(subagentRuns, context, () => {});
    const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const sampledBytes = values.allocation
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        )
      : undefined;
    if (values.profile) {
      writeFileSync(
        `${values.output}.${trial}.cpuprofile`,
        JSON.stringify((await inspector.post("Profiler.stop")).profile),
      );
    }
    const waitable = [...subagentRuns.values()].filter((row) => row.collectorCompletion).length;
    trials.push({
      phase: trial === 0 ? "cold-owner" : "warm-owner",
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      waitable,
      ...(values["shutdown-completions"]
        ? {
            recoveredCompletions: [...subagentRuns.values()].filter(
              (row) =>
                row.expectsCompletionMessage &&
                row.endedReason === "subagent-error" &&
                row.completion?.capturedAt !== undefined &&
                row.delivery?.status === "pending" &&
                !row.killReconciliation &&
                !row.suppressCompletionDelivery,
            ).length,
          }
        : {}),
    });
  }
  writeFileSync(
    values.output,
    JSON.stringify(
      {
        sourceHash: hash("sha256", source),
        fixture,
        control: values.control,
        shutdownCompletions: values["shutdown-completions"],
        allocation: values.allocation,
        load: loadavg(),
        runs: rows.size,
        interrupted: 16,
        trials,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
} finally {
  inspector.disconnect();
  subagentRuns.clear();
  await closeOpenClawStateDatabaseAsync();
}
