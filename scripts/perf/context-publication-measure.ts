/**
 * Indexed provider-bound context publication against a canonical synthetic fixture.
 * Seed with team-shape-fixture.ts --state-dir <new-dir> --sessions 5000
 * --runs 0 --approvals 0 --cron 0 --projects 1 --transcript-mib <pilot-scaled-mib>
 * --worktree-files 62000 --worktree-file-bytes 19000.
 * Inspect physical DB bytes: transcript indexes make logical MiB a poor size proxy.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/context-publication-measure.ts
 *   --state-dir <fixture> --iterations 100 --mode timing|allocation
 * Each operation awaits the real publisher/writer; records main-thread and total
 * process CPU, main-thread allocation, and wall time. Five A/A pairs detect noise.
 * Baseline had no per-request write: this reports the added owner cost, not a
 * claimed storage speedup. Existing maintenance settings retain the seeded age
 * and size; before/after inventory counts stay outside the measured operation.
 * No transcript payload or workspace files are traversed.
 */
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SessionMaintenanceConfig } from "../../src/config/types.base.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    iterations: { type: "string", default: "100" },
    mode: { type: "string", default: "timing" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["timing", "allocation"].includes(values.mode));
const gc = global.gc;
assert(gc, "use --expose-gc");
assert(values["state-dir"], "Supply a canonical synthetic --state-dir");
const root = path.resolve(values["state-dir"]);
const summary = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(summary.format, "openclaw-team-shape-v1");
assert(summary.sessionCount >= 2, "Use at least two sessions for a nonarchived target");
const configPath = path.join(root, "openclaw.json");
const env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
// Bind fixture scope before importing owners whose resolvers capture environment.
process.env = env;
const { publishEmbeddedRequestContext } =
  await import("../../src/agents/embedded-agent-runner/run/attempt-context-accounting.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/config.js");
const { loadSessionEntry, patchSessionEntryCore } =
  await import("../../src/config/sessions/session-accessor.js");
const { composeSessionSourceAssertion } =
  await import("../../src/config/sessions/session-source-authority.js");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { readSessionEntryCount } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-inventory.js");
const { resolveSessionStorePathCore } = await import("../../src/config/sessions/paths.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const fixtureConfig: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
const maintenance = {
  ...fixtureConfig.session?.maintenance,
  mode: "enforce",
  pruneAfter: "365d",
  archiveDashboardAfter: "365d",
  maxEntries: Math.max(5_000, summary.sessionCount),
  maxDiskBytes: 100 * 1024 ** 3,
} satisfies SessionMaintenanceConfig;
setRuntimeConfigSnapshot({
  ...fixtureConfig,
  session: { ...fixtureConfig.session, maintenance },
});
try {
  const writer = "synthetic-context-writer";
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const sessionsBefore = readSessionEntryCount(database);
  assert.equal(sessionsBefore, summary.sessionCount);
  const source = {
    agentId: "main",
    env,
    storePath: resolveSessionStorePathCore(fixtureConfig.session?.store, { agentId: "main", env }),
    sessionKey: "agent:main:team-shape-session-1",
  };
  const entry = loadSessionEntry(source);
  assert(entry && entry.lifecycleRevision && !entry.archivedAt);
  await patchSessionEntryCore(source, () => ({ activeWriterRunId: writer }), {
    skipMaintenance: true,
    preserveActivity: true,
  });
  const target = {
    ...source,
    sessionId: entry.sessionId,
    expectedLifecycleRevision: entry.lifecycleRevision,
    expectedWriterRunId: writer,
  };
  const attempt = {
    runId: writer,
    preparedSessionTarget: { target, assertCurrent: composeSessionSourceAssertion([]) },
  };
  let tokens = 650_000;
  const publish = async () => publishEmbeddedRequestContext(attempt, ++tokens);
  for (let index = 0; index < 20; index++) {
    await publish();
  }
  for (let sample = 0; sample < 5; sample++) {
    for (const arm of sample % 2 === 0 ? ["a", "b"] : ["b", "a"]) {
      gc();
      const inspector = new Session();
      if (values.mode === "allocation") {
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const durations: number[] = [];
      const operations: Record<string, number> = {};
      const observe = (event: unknown) => {
        if (
          event &&
          typeof event === "object" &&
          "operation" in event &&
          typeof event.operation === "string"
        ) {
          operations[event.operation] = (operations[event.operation] ?? 0) + 1;
        }
      };
      const reservations = channel("openclaw.session.write");
      reservations.subscribe(observe);
      const processCpu = process.cpuUsage();
      const threadCpu = process.threadCpuUsage();
      const started = performance.now();
      for (let index = 0; index < iterations; index++) {
        const before = performance.now();
        await publish();
        durations.push(performance.now() - before);
      }
      const wallMs = performance.now() - started;
      const totalCpu = process.cpuUsage(processCpu);
      const mainCpu = process.threadCpuUsage(threadCpu);
      reservations.unsubscribe(observe);
      let allocatedBytes: number | undefined;
      if (values.mode === "allocation") {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
          node.selfSize + node.children.reduce((value, child) => value + sum(child), 0);
        allocatedBytes = sum(profile.head);
        inspector.disconnect();
      }
      assert.equal(loadSessionEntry(target)?.totalTokens, tokens);
      assert.equal(loadSessionEntry(target)?.updatedAt, entry.updatedAt);
      durations.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          arm,
          sample: sample + 1,
          mode: values.mode,
          sessions: summary.sessionCount,
          agentDatabaseBytes: summary.agentDatabaseBytes,
          logicalTranscriptBytes: summary.logicalTranscriptBytes,
          worktreeFiles: summary.worktreeFiles,
          iterations,
          operations,
          wallMs,
          mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
          processCpuMs: (totalCpu.user + totalCpu.system) / 1000,
          p50Ms: durations[Math.floor(durations.length * 0.5)],
          p95Ms: durations[Math.floor(durations.length * 0.95)],
          allocatedBytes,
          bytesPerOperation: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
          hostLoad: loadavg(),
        }),
      );
    }
  }
  const sessionsAfter = readSessionEntryCount(database);
  assert.equal(sessionsAfter, sessionsBefore);
  console.log(JSON.stringify({ sessionsBefore, sessionsAfter, maintenance }));
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
