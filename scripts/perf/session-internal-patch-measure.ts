/**
 * Internal session patch owner benchmark; no Gateway or production state access.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-internal-patch-measure.ts \
 *   --label candidate --iterations 1000 --state-dir .local/internal-patch/candidate-1
 * Repeat on base, alternating arms; add --allocations for a separate sampling pass.
 * Accept identical final entry digests, fewer writer requests, and lower main-thread
 * CPU/allocation. GC/timing from allocation passes is context, not an acceptance gate.
 * Four warm synthetic entries carry 40 skill/tool records. Each simulated turn
 * repeats channel metadata/route, progress, lifecycle and cron producers. This is
 * an owner workload, not evidence of production producer frequency or Gateway tails.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { SessionEntryPatchOperation } from "../../src/config/sessions/session-entry-patch-operation.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "candidate" },
    iterations: { type: "string", default: "1000" },
    "state-dir": { type: "string" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "Use positive integer --iterations");
assert(values["state-dir"], "Pass a new isolated --state-dir under .local");
const root = path.resolve(values["state-dir"]);
assert(root.startsWith(`${path.resolve(".local")}${path.sep}`), "State must stay under .local");
mkdirSync(path.dirname(root), { recursive: true });
mkdirSync(root, { mode: 0o700 });
process.env.TMPDIR = root;
const sources = Object.fromEntries(
  ["session-entry-patch", "session-entry-patch-operation"].map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(path.resolve("src/config/sessions", `${name}.ts`)))
      .digest("hex"),
  ]),
);
const [
  { withOpenClawTestState },
  { openOpenClawAgentDatabase },
  {
    applySessionEntryOperation,
    replaceSessionEntrySync,
    recordInboundSessionMeta,
    updateSessionLastRouteInScope,
  },
  { readExactSessionEntryRow },
  { onWorkerRequestMetrics },
  { setDiagnosticsEnabledForProcess, areDiagnosticsEnabledForProcess },
] = await Promise.all([
  import("../../src/test-utils/openclaw-test-state.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/infra/worker-request-diagnostics.js"),
  import("../../src/infra/diagnostic-events.js"),
]);
await withOpenClawTestState({ scenario: "minimal" }, async () => {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = (name: string) => ({
    agentId: "main",
    storePath: database.path,
    sessionKey: `agent:main:patch-${name}`,
  });
  const names = ["channel", "subagent", "lifecycle", "cron"];
  const anchor = Date.UTC(2026, 9, 25);
  const entries = names.map((name): InternalSessionEntry => ({
    sessionId: `patch-${name}`,
    updatedAt: anchor,
    label: `Synthetic ${name}`,
    createdAt: anchor,
    createdVia: "internal",
    status: "done",
    skillsSnapshot: {
      prompt: "Synthetic skill instructions. ".repeat(2048),
      skills: Array.from({ length: 40 }, (_, index) => ({ name: `skill-${index}` })),
    },
    systemPromptReport: {
      source: "run",
      generatedAt: anchor,
      systemPrompt: { chars: 61440, projectContextChars: 0, nonProjectContextChars: 61440 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 61440, entries: [] },
      tools: {
        listChars: 4000,
        schemaChars: 16000,
        entries: Array.from({ length: 40 }, (_, index) => ({
          name: `tool-${index}`,
          summaryChars: 100,
          schemaChars: 400,
        })),
      },
    },
  }));
  names.forEach((name, index) => replaceSessionEntrySync(scope(name), entries[index]!));
  const ctx = { Provider: "reef", From: "reef:synthetic", ChatType: "direct" };
  const route = { channel: "reef", to: "user:synthetic", ctx };
  let producer = "warmup";
  let measured = false;
  const commits: Record<string, number> = {
    "inbound-metadata": 0,
    "delivery-route": 0,
    "subagent-progress": 0,
    "lifecycle-terminal": 0,
    "cron-session": 0,
  };
  const diagnostics = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  const unsubscribe = onWorkerRequestMetrics((kind, command, phase) => {
    if (
      measured &&
      kind === "sqlite_writer" &&
      command === "session.entry.patch.commit" &&
      phase === "completed"
    ) {
      commits[producer] = (commits[producer] ?? 0) + 1;
    }
  });
  const apply = (name: string, operation: SessionEntryPatchOperation, replaceEntry = false) =>
    applySessionEntryOperation(scope(name), operation, {
      preserveActivity: true,
      skipMaintenance: true,
      replaceEntry,
      // Lifecycle callers consume commit effects even when the terminal event repeats.
      onCommitted: name === "lifecycle" ? () => {} : undefined,
    });
  async function run(count: number, offset = 0) {
    for (let index = 0; index < count; index++) {
      const sequence = index + offset;
      producer = "inbound-metadata";
      await recordInboundSessionMeta({ ...scope("channel"), ctx });
      producer = "delivery-route";
      await updateSessionLastRouteInScope(scope("channel"), route);
      producer = "subagent-progress";
      const progress = {
        kind: "fields",
        patch: { lastActivityAt: anchor + sequence + 1 },
      } as const;
      await apply("subagent", progress);
      await apply("subagent", progress);
      producer = "lifecycle-terminal";
      const lifecycle: SessionEntryPatchOperation = {
        kind: "lifecycle",
        lifecycle: {
          canonicalKey: scope("lifecycle").sessionKey,
          currentLifecycleGeneration: "synthetic",
          exactCronRun: false,
          event: {
            ts: anchor + sequence + 1,
            sessionId: "patch-lifecycle",
            runId: `run-${sequence}`,
            data: { phase: "end", endedAt: anchor + sequence + 1 },
          },
        },
      };
      await apply("lifecycle", lifecycle);
      await apply("lifecycle", lifecycle);
      producer = "cron-session";
      const initial = entries[3]!;
      const cron: SessionEntryPatchOperation = {
        kind: "cron-session",
        sessionKey: scope("cron").sessionKey,
        initial,
        next: { ...initial, updatedAt: anchor + sequence + 1 },
        creation: { createdAt: anchor, createdVia: "cron" },
      };
      await apply("cron", cron, true);
      await apply("cron", cron, true);
    }
  }
  const inspector = values.allocations ? new Session() : undefined;
  try {
    await run(8, -8);
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
    const finalEntries = names.map(
      (name) => readExactSessionEntryRow(database, scope(name).sessionKey)?.entry,
    );
    assert.equal(finalEntries[1]?.lastActivityAt, anchor + iterations);
    assert.equal(finalEntries[2]?.endedAt, anchor + iterations);
    assert.equal(finalEntries[3]?.updatedAt, anchor + iterations);
    const byKind = Object.groupBy(gcStats, (sample) => sample.gcType);
    const result = {
      label: values.label,
      mode: values.allocations ? "allocation" : "timing",
      node: process.version,
      iterations,
      callsPerTurn: 8,
      skillRecords: 40,
      toolRecords: 40,
      sources,
      digest: createHash("sha256").update(JSON.stringify(finalEntries)).digest("hex"),
      elapsedMs,
      threadCpuMs: (used.user + used.system) / 1000,
      cpuUsPerTurn: (used.user + used.system) / iterations,
      allocatedBytes,
      allocatedBytesPerTurn: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      commits,
      commitsPerTurn: Object.fromEntries(
        Object.entries(commits).map(([name, count]) => [name, count / iterations]),
      ),
      commitsPerMinute: Object.fromEntries(
        Object.entries(commits).map(([name, count]) => [name, (count * 60000) / elapsedMs]),
      ),
      gcSecondsPerMinute:
        ((gcStats.reduce((sum, sample) => sum + sample.cost, 0) / 1e6) * 60000) / elapsedMs,
      gcByKind: Object.fromEntries(
        Object.entries(byKind).map(([kind, samples]) => [
          kind,
          {
            count: samples!.length,
            totalMs: samples!.reduce((sum, sample) => sum + sample.cost, 0) / 1000,
            maxMs: Math.max(...samples!.map((sample) => sample.cost)) / 1000,
          },
        ]),
      ),
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
