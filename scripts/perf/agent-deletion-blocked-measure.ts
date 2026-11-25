/**
 * Measure the synchronous deletion guard against offline synthetic Team-shaped state.
 * Seed with team-shape-fixture.ts --sessions 10000 --runs 3981 --settled-runs
 * --team-stress --approvals 0 --cron 0 --projects 0 --transcript-mib 0.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-deletion-blocked-measure.ts
 *   --state-dir <fixture> [--owner <baseline-module.ts>] [--iterations 10000] [--prepared]
 *   [--warmup 100000] [--samples 5]
 *   [--first-use-audit --status-owner <baseline-status.ts> --expected-blocked 4]
 * Alternate base/candidate launches. Timing and sampled allocation are separate;
 * preparation is outside measurement. Both ordinary and inherited snapshot contexts
 * use the real owner and journal worker. This does not measure connected clients,
 * Gateway throughput, or reproduce a production stall.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    owner: { type: "string" },
    "status-owner": { type: "string" },
    "first-use-audit": { type: "boolean", default: false },
    "expected-blocked": { type: "string", default: "0" },
    prepared: { type: "boolean", default: false },
    iterations: { type: "string", default: "10000" },
    warmup: { type: "string", default: "1000" },
    samples: { type: "string", default: "1" },
  },
});
assert(values["state-dir"] && globalThis.gc, "Supply --state-dir and run with --expose-gc");
const iterations = Number(values.iterations);
const warmup = Number(values.warmup);
const samples = Number(values.samples);
for (const count of [iterations, warmup, samples]) {
  assert(Number.isSafeInteger(count) && count > 0);
}
const root = path.resolve(values["state-dir"]);
const summary = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(summary.format, "openclaw-team-shape-v1");
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const { isAgentDeletionBlocked, prepareAgentDeletionBlocked } = (await import(
  pathToFileURL(path.resolve(values.owner ?? "src/agents/agent-lifecycle-registry.ts")).href
)) as typeof import("../../src/agents/agent-lifecycle-registry.js");
const { readAgentDeletionJournalStatusInWorker } =
  await import("../../src/state/agent-deletion-journal.read.js");
const { executeExistingOpenClawStateRead, withOpenClawStateDatabaseReadSnapshot } =
  await import("../../src/state/openclaw-state-db-readonly.js");
const {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} = await import("../../src/state/openclaw-state-db.js");
const { loadAgentDeletionJournalStatus } = (await import(
  pathToFileURL(
    path.resolve(values["status-owner"] ?? "src/state/agent-deletion-journal-status.ts"),
  ).href
)) as typeof import("../../src/state/agent-deletion-journal-status.js");
const { ensureExecutionOwnerLifecycleBindingSchema } =
  await import("../../src/audit/execution-owner-lifecycle-binding-store.js");
const options = { env: process.env };
const agents = ["main", "reviewer", "researcher", "planner"];
const inspector = new Session();
inspector.connect();
try {
  const database = openOpenClawStateDatabase(options);
  const prepare = async () => {
    for (const agent of agents) {
      const status = values["first-use-audit"]
        ? await loadAgentDeletionJournalStatus(database.path, agent, async () => {
            const reply = await executeExistingOpenClawStateRead(
              options,
              { type: "agentDeletionJournal.status", agentId: agent },
              { current: true },
            );
            return reply?.status ?? "absent";
          })
        : await readAgentDeletionJournalStatusInWorker(agent, options);
      assert.equal(status, "absent");
    }
  };
  await prepare();
  const checks = agents.map((agent) =>
    values.prepared
      ? prepareAgentDeletionBlocked(agent, options)
      : () => isAgentDeletionBlocked(agent, options),
  );
  const run = (count: number) => {
    let blocked = 0;
    for (let index = 0; index < count; index++) {
      blocked += Number(checks[index % checks.length]!());
    }
    assert.equal(blocked, 0);
  };
  const allocation = async (operation: () => void) => {
    globalThis.gc!();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    operation();
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const pending = [profile.head];
    let allocatedBytes = 0;
    while (pending.length) {
      const node = pending.pop()!;
      allocatedBytes += node.selfSize;
      pending.push(...node.children);
    }
    return allocatedBytes;
  };
  if (values["first-use-audit"]) {
    const reset = async () => {
      // Task-owned synthetic fixture only; recreate the real optional first-use table.
      runOpenClawStateWriteTransaction(
        ({ db }) => db.exec("DROP TABLE IF EXISTS execution_owner_lifecycle_bindings"),
        options,
      );
      await prepare();
    };
    const firstUse = () =>
      runOpenClawStateWriteTransaction(
        ({ db }) => ensureExecutionOwnerLifecycleBindingSchema(db),
        options,
      );
    await reset();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    firstUse();
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const blockedAgents = checks.filter((check) => check()).length;
    assert.equal(blockedAgents, Number(values["expected-blocked"]));
    await reset();
    const allocatedBytes = await allocation(firstUse);
    console.log(
      JSON.stringify({
        context: "first-use-audit",
        blockedAgents,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes,
        hostLoad: loadavg(),
      }),
    );
    await prepare();
  }
  const measure = async (context: string, sample: number) => {
    run(warmup);
    globalThis.gc!();
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    run(iterations);
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const allocatedBytes = await allocation(() => run(iterations));
    console.log(
      JSON.stringify({
        context,
        prepared: values.prepared,
        iterations,
        warmup,
        sample,
        sessions: summary.sessionCount,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes,
        hostLoad,
        memory: process.memoryUsage(),
      }),
    );
  };
  for (let sample = 1; sample <= samples; sample++) {
    await measure("ordinary", sample);
    await withOpenClawStateDatabaseReadSnapshot(() => measure("snapshot", sample), {
      ...options,
      lazy: true,
    });
  }
} finally {
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
}
