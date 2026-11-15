/**
 * Subagent timing owner workload; synthetic state only, no Gateway or production access.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-timing-write-measure.ts \
 *   --label candidate --iterations 250 --state-dir .local/timing/candidate-1
 * Alternate base/candidate arms; add --allocations for a separate sampling pass.
 * --owner-dir <sparse-overlay> selects the baseline helper at its repository-relative
 * path while unchanged dependencies remain in this checkout; hash the selected source.
 * Each simulated minute completes four active subagents, repeats their timing,
 * and replays four already completed subagents among 10,000 idle/active sessions.
 * The eight active rows carry 40 skill/tool records. Default: 3,000 owner calls.
 * Accept identical final digests, fewer sessions-class requests and lower main-thread
 * CPU/allocation. This measures a declared owner workload, not production frequency,
 * actual channel/cron/Control UI traffic, or whole-Gateway latency and memory.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "candidate" },
    iterations: { type: "string", default: "250" },
    sessions: { type: "string", default: "10000" },
    "state-dir": { type: "string" },
    "owner-dir": { type: "string" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
const sessions = Number(values.sessions);
assert(Number.isSafeInteger(iterations) && iterations > 0, "Use positive integer --iterations");
assert(Number.isSafeInteger(sessions) && sessions >= 8, "Use integer --sessions >= 8");
assert(values["state-dir"], "Pass a new isolated --state-dir under .local");
const root = path.resolve(values["state-dir"]);
assert(root.startsWith(`${path.resolve(".local")}${path.sep}`), "State must stay under .local");
mkdirSync(path.dirname(root), { recursive: true });
mkdirSync(root, { mode: 0o700 });
process.env.TMPDIR = root;
const source = "src/agents/subagents/registry/subagent-registry-helpers.ts";
const sourceHash = createHash("sha256")
  .update(readFileSync(values["owner-dir"] ? path.resolve(values["owner-dir"], source) : source))
  .digest("hex");
if (values["owner-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["owner-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const [
  { withOpenClawTestState },
  { openOpenClawAgentDatabase, runOpenClawAgentWriteTransaction },
  { readExactSessionEntryRow, writeSessionEntry },
  { persistSubagentSessionTiming },
  { onWorkerRequestMetrics },
  { setDiagnosticsEnabledForProcess, areDiagnosticsEnabledForProcess },
] = await Promise.all([
  import("../../src/test-utils/openclaw-test-state.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/agents/subagents/registry/subagent-registry-helpers.js"),
  import("../../src/infra/worker-request-diagnostics.js"),
  import("../../src/infra/diagnostic-events.js"),
]);
await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
  const { captureRuntimeConfigAsyncReader } = await import("../../src/config/io.js");
  await captureRuntimeConfigAsyncReader()();
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const options = { agentId: "main", path: database.path, env };
  const key = (index: number) => `agent:main:subagent:synthetic-timing-${index}`;
  const anchor = Date.UTC(2026, 9, 25);
  const startedAt = anchor - 1000;
  const active: InternalSessionEntry[] = [];
  runOpenClawAgentWriteTransaction((current) => {
    for (let index = 0; index < sessions; index++) {
      const entry: InternalSessionEntry = {
        sessionId: `synthetic-timing-${index}`,
        lifecycleRevision: `synthetic-revision-${index}`,
        updatedAt: anchor,
        status: "done",
        startedAt,
        endedAt: anchor,
        runtimeMs: 1000,
        label: `Synthetic task ${index}`,
        ...(index < 8
          ? {
              skillsSnapshot: {
                prompt: "Synthetic skill instructions. ".repeat(2048),
                skills: Array.from({ length: 40 }, (_, skill) => ({ name: `skill-${skill}` })),
              },
              systemPromptReport: {
                source: "run" as const,
                generatedAt: anchor,
                systemPrompt: {
                  chars: 61440,
                  projectContextChars: 0,
                  nonProjectContextChars: 61440,
                },
                injectedWorkspaceFiles: [],
                skills: { promptChars: 61440, entries: [] },
                tools: {
                  listChars: 4000,
                  schemaChars: 16000,
                  entries: Array.from({ length: 40 }, (_, tool) => ({
                    name: `tool-${tool}`,
                    summaryChars: 100,
                    schemaChars: 400,
                  })),
                },
              },
            }
          : {}),
      };
      writeSessionEntry(current, key(index), entry);
      if (index < 8) {
        active.push(entry);
      }
    }
  }, options);
  const record = (index: number, endedAt: number): SubagentRunRecord => ({
    runId: `synthetic-run-${index}`,
    childAgentId: "main",
    childSessionKey: key(index),
    childSessionIdentity: active[index],
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Synthetic timing completion",
    cleanup: "keep",
    createdAt: startedAt,
    sessionStartedAt: startedAt,
    execution: { status: "terminal", startedAt, endedAt, outcome: { status: "ok" } },
  });
  const requests: Record<string, number> = {
    completion: 0,
    "completion-replay": 0,
    "stable-replay": 0,
  };
  let producer = "warmup";
  let measured = false;
  const diagnostics = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  const unsubscribe = onWorkerRequestMetrics((kind, command, phase) => {
    if (measured && kind === "sqlite_writer" && command === "sessions" && phase === "completed") {
      requests[producer] = (requests[producer] ?? 0) + 1;
    }
  });
  const persist = (index: number, endedAt: number) =>
    persistSubagentSessionTiming(record(index, endedAt), {
      session: { storePath: database.path, entry: active[index], assertCurrent() {} },
    });
  async function run(count: number, offset = 0) {
    for (let minute = 0; minute < count; minute++) {
      const endedAt = anchor + minute + offset + 1;
      for (let index = 0; index < 4; index++) {
        producer = "completion";
        await persist(index, endedAt);
        producer = "completion-replay";
        await persist(index, endedAt);
        producer = "stable-replay";
        await persist(index + 4, anchor);
      }
    }
  }
  const inspector = values.allocations ? new Session() : undefined;
  try {
    await run(2, -2);
    globalThis.gc?.();
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const gc = new GCProfiler();
    gc.start();
    const memoryBefore = process.memoryUsage();
    const hostLoadBefore = loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    measured = true;
    await run(iterations);
    measured = false;
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const gcStats = gc.stop()?.statistics ?? [];
    const memoryAfter = process.memoryUsage();
    const allocatedBytes = inspector
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        )
      : undefined;
    const finalEntries = active.map(
      (_, index) => readExactSessionEntryRow(database, key(index))?.entry,
    );
    finalEntries.forEach((entry, index) => {
      assert.equal(entry?.endedAt, index < 4 ? anchor + iterations : anchor);
      assert.equal(entry?.status, "done");
      assert.equal(entry?.updatedAt, anchor);
    });
    const result = {
      label: values.label,
      mode: values.allocations ? "allocation" : "timing",
      node: process.version,
      sourceHash,
      sessions,
      iterations,
      calls: iterations * 12,
      simulatedMinutes: iterations,
      skillRecordsPerActiveSession: 40,
      toolRecordsPerActiveSession: 40,
      digest: createHash("sha256").update(JSON.stringify(finalEntries)).digest("hex"),
      elapsedMs,
      threadCpuMs: (used.user + used.system) / 1000,
      cpuUsPerCall: (used.user + used.system) / (iterations * 12),
      allocatedBytes,
      allocatedBytesPerCall:
        allocatedBytes === undefined ? undefined : allocatedBytes / (iterations * 12),
      requests,
      requestsPerSimulatedMinute: Object.fromEntries(
        Object.entries(requests).map(([name, count]) => [name, count / iterations]),
      ),
      gcSecondsPerMinute:
        ((gcStats.reduce((sum, sample) => sum + sample.cost, 0) / 1e6) * 60000) / elapsedMs,
      memoryBefore,
      memoryAfter,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    };
    writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } finally {
    inspector?.disconnect();
    unsubscribe();
    setDiagnosticsEnabledForProcess(diagnostics);
  }
});
