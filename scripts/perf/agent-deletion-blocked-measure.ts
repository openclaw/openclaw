/**
 * Measure the synchronous deletion guard against offline synthetic Team-shaped state.
 * Seed with team-shape-fixture.ts --sessions 10000 --runs 3981 --settled-runs
 * --team-stress --approvals 0 --cron 0 --projects 0 --transcript-mib 0.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-deletion-blocked-measure.ts
 *   --state-dir <fixture> [--owner <baseline-module.ts>] [--iterations 10000] [--prepared]
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
    prepared: { type: "boolean", default: false },
    iterations: { type: "string", default: "10000" },
  },
});
assert(values["state-dir"] && globalThis.gc, "Supply --state-dir and run with --expose-gc");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
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
const { withOpenClawStateDatabaseReadSnapshot } =
  await import("../../src/state/openclaw-state-db-readonly.js");
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.js");
const options = { env: process.env };
const agents = ["main", "reviewer", "researcher", "planner"];
const inspector = new Session();
inspector.connect();
try {
  openOpenClawStateDatabase(options);
  for (const agent of agents) {
    assert.equal(await readAgentDeletionJournalStatusInWorker(agent, options), "absent");
  }
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
  const measure = async (context: string) => {
    run(1000);
    globalThis.gc!();
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    run(iterations);
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    globalThis.gc!();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run(iterations);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const pending = [profile.head];
    let allocatedBytes = 0;
    while (pending.length) {
      const node = pending.pop()!;
      allocatedBytes += node.selfSize;
      pending.push(...node.children);
    }
    console.log(
      JSON.stringify({
        context,
        prepared: values.prepared,
        iterations,
        sessions: summary.sessionCount,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes,
        hostLoad,
        memory: process.memoryUsage(),
      }),
    );
  };
  await measure("ordinary");
  await withOpenClawStateDatabaseReadSnapshot(() => measure("snapshot"), {
    ...options,
    lazy: true,
  });
} finally {
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
}
