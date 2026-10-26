/**
 * Synthetic exec-policy owner benchmark. Run on baseline and candidate separately:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/exec-approvals-measure.ts \
 *   --state-dir .local/exec-policy-base --iterations 3000
 * Repeat with --allocation and a fresh state directory for sampled allocation;
 * never use traced timing/GC to judge regressions. Sampling includes collected
 * objects. Fixtures: 40 agents, 64 allowlist entries and 8 MCP grants per agent.
 * Warm prepared reads and final current-policy guards use the real SQLite owner.
 * Matching rotates basename/path grants, denial, and a dot-segment escape.
 * Setup, warmup, explicit GC, and teardown are outside measured windows. GC
 * counts and maxima describe these short owner runs, not Gateway latency tails.
 * The supplied state directory must not exist; this script removes its own
 * synthetic database after closing it. It never opens an operator's state.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { ExecApprovalsFile } from "../../src/infra/exec-approvals-core.js";
import type { ExecAllowlistEntry } from "../../src/infra/exec-approvals.types.js";
import type { ExecutableResolution } from "../../src/infra/exec-command-resolution.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"], "--state-dir is required");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 3000,
});
const stateDir = path.resolve(values["state-dir"]);
assert(!existsSync(stateDir), "--state-dir must be a fresh synthetic fixture directory");
mkdirSync(stateDir, { recursive: true });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");

const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.js");
const { captureOpenClawStateWorkerContext } =
  await import("../../src/state/openclaw-state-worker-context.js");
const { writeExecApprovalsConfigRow } = await import("../../src/infra/exec-approvals-sqlite.js");
const { readExecApprovalsSnapshotAsync, prepareExecApprovalsCurrentRead } =
  await import("../../src/infra/exec-approvals-store.js");
const { matchAllowlist } = await import("../../src/infra/exec-command-resolution.js");

const entries: ExecAllowlistEntry[] = [
  ...Array.from({ length: 61 }, (_, index) => ({ pattern: `/synthetic/tools/other-${index}/**` })),
  { pattern: "r?" },
  { pattern: "/synthetic/tools/allowed/**" },
  { pattern: "python3", argPattern: "^--version$" },
];
const file: ExecApprovalsFile = {
  version: 1,
  defaults: { security: "allowlist", ask: "on-miss" },
  agents: Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `agent-${index}`,
      {
        allowlist: entries.map((entry, entryIndex) => ({
          pattern: entry.pattern,
          argPattern: entry.argPattern,
          id: `agent-${index}-entry-${entryIndex}`,
          lastUsedAt: 1,
          lastUsedCommand: "synthetic command",
        })),
        mcpTools: Array.from({ length: 8 }, (_tool, toolIndex) => ({
          server: "synthetic-server",
          tool: `tool-${toolIndex}`,
          source: "allow-always" as const,
          addedAt: 1,
        })),
      },
    ]),
  ),
};
const targets: ExecutableResolution[] = [
  ["rg", "/synthetic/bin/rg"],
  ["/synthetic/tools/allowed/tool", "/synthetic/tools/allowed/tool"],
  ["blocked", "/synthetic/tools/private/tool"],
  ["/synthetic/tools/allowed/../../private/tool", "/synthetic/tools/allowed/../../private/tool"],
].map(([rawExecutable, resolvedPath]) => ({
  kind: "executable",
  rawExecutable: rawExecutable!,
  resolvedPath: resolvedPath!,
  executableName: path.posix.basename(rawExecutable!),
}));
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
const inspector = new Session();
let sink = 0;
try {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawStateDatabase({ env });
  writeExecApprovalsConfigRow({ db: database.db, file });
  const context = captureOpenClawStateWorkerContext({ env });
  const initial = await readExecApprovalsSnapshotAsync(context);
  assert.equal(Object.keys(initial.file.agents ?? {}).length, 40);
  const readCurrent = await prepareExecApprovalsCurrentRead(context);
  const allowlist = initial.file.agents!["agent-0"]!.allowlist!;
  assert.deepEqual(
    targets.map((target) => Boolean(matchAllowlist(allowlist, target))),
    [true, true, false, false],
  );
  const workloads: Record<string, (count: number) => void | Promise<void>> = {
    matchAllowlist(count) {
      for (let index = 0; index < count; index++) {
        sink += Number(Boolean(matchAllowlist(allowlist, targets[index % targets.length]!)));
      }
    },
    async preparedRead(count) {
      for (let index = 0; index < count; index++) {
        sink += (await readExecApprovalsSnapshotAsync(context)).file.version;
      }
    },
    currentRead(count) {
      for (let index = 0; index < count; index++) {
        sink += readCurrent().version;
      }
    },
  };
  if (values.allocation) {
    inspector.connect();
  }
  for (const [workload, run] of Object.entries(workloads)) {
    await run(100);
    global.gc();
    await nextTurn();
    const collections: PerformanceEntry[] = [];
    const observer = new PerformanceObserver((batch) => collections.push(...batch.getEntries()));
    observer.observe({ entryTypes: ["gc"] });
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const beforeMemory = process.memoryUsage();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    await run(iterations);
    const ended = performance.now();
    const used = process.threadCpuUsage(cpu);
    const afterMemory = process.memoryUsage();
    await nextTurn();
    collections.push(...observer.takeRecords());
    observer.disconnect();
    const profile = values.allocation
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    const pauses = collections
      .filter((entry) => entry.startTime >= started && entry.startTime < ended)
      .map((entry) => entry.duration);
    console.log(
      JSON.stringify({
        workload,
        mode: values.allocation ? "allocation" : "untraced",
        iterations,
        fixture: { agents: 40, entriesPerAgent: 64, mcpGrantsPerAgent: 8 },
        elapsedMs: ended - started,
        mainThreadCpuUsPerOperation: (used.user + used.system) / iterations,
        allocatedBytesPerOperation: profile ? allocated(profile.head) / iterations : undefined,
        gc: {
          count: pauses.length,
          totalMs: pauses.reduce((sum, pause) => sum + pause, 0),
          maxMs: Math.max(0, ...pauses),
        },
        beforeMemory,
        afterMemory,
        hostLoad,
        sink,
      }),
    );
  }
} finally {
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
  rmSync(stateDir, { recursive: true });
}
