/**
 * Synthetic shutdown-owner measurement; never point this at live state.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-shutdown-completion-measure.ts \
 *   --fixture /absolute/team-shape-copy --output /absolute/result.json \
 *   [--source /absolute/subagent-registry.base.ts] [--allocation]
 * Interleave five A/A/B processes. Imports, seeding and hydration are outside timing.
 * Measure the joined shutdown owner with admission closed: 16 active children among
 * 4,300 retained runs. Acceptance: every interrupted child retains a required outcome;
 * report the cost of the durable writes, including any increase over quiet cancellation.
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
    allocation: { type: "boolean", default: false },
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
const owner = new URL("../../src/agents/subagents/registry/subagent-registry.ts", import.meta.url);
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
const { createDefaultDeps } = await import("../../src/cli/deps.js");
const { withLocalGatewayRequestScope } = await import("../../src/gateway/local-request-context.js");
const { bindGatewayContextResolver, getPluginRuntimeGatewayRequestScope } =
  await import("../../src/plugins/runtime/gateway-request-scope.js");
const { markGatewayRestartDraining } = await import("../../src/process/gateway-work-admission.js");
const { claimAgentRunContext, releaseAgentRunContext } =
  await import("../../src/infra/agent-run-registry.js");
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.js");
const { terminateLiveSubagentsForShutdown } =
  await import("../../src/agents/subagents/registry/subagent-registry.js");
const { restoreSubagentRunsFromDisk } =
  await import("../../src/agents/subagents/registry/subagent-registry-persistence.js");
const { saveSubagentRegistryToSqlite } =
  await import("../../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
assert(loaded, "Requested owner was not loaded");
const cfg = await captureRuntimeConfigAsyncReader()();
const now = Date.now();
const rows = new Map<string, SubagentRunRecord>();
for (let i = 0; i < 4300; i++) {
  const active = i < 16;
  const runId = `shutdown-${i}`;
  rows.set(runId, {
    runId,
    childAgentId: "main",
    childSessionKey: `agent:main:subagent:${runId}`,
    childSessionIdentity: { sessionId: runId, lifecycleRevision: runId },
    requesterAgentId: "main",
    requesterSessionKey: `agent:main:dashboard:synthetic-${i}`,
    requesterDisplayKey: "Synthetic requester",
    task: `Synthetic child ${i}`,
    cleanup: "keep",
    spawnMode: "run",
    createdAt: now - 1000,
    expectsCompletionMessage: true,
    execution: active
      ? { status: "running", startedAt: now - 1000 }
      : {
          status: "terminal",
          startedAt: now - 1000,
          endedAt: now - 500,
          outcome: { status: "ok" },
        },
    completion: { required: true, ...(active ? {} : { resultText: "Synthetic result" }) },
    delivery: { status: active ? "pending" : "delivered" },
    ...(active ? {} : { cleanupCompletedAt: now - 500, archiveAtMs: now + 86_400_000 }),
  });
}
saveSubagentRegistryToSqlite(rows);
await restoreSubagentRunsFromDisk({ runs: subagentRuns });
const inspector = new Session();
const claims = new Map<string, string>();
inspector.connect();
try {
  await withLocalGatewayRequestScope(
    { deps: createDefaultDeps(), getRuntimeConfig: () => cfg },
    async () => {
      const resolver = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
      assert(resolver, "Local production Gateway context was not installed");
      for (const entry of subagentRuns.values()) {
        bindGatewayContextResolver(entry, resolver);
        if (entry.execution.status === "running") {
          const claim = claimAgentRunContext(
            entry.runId,
            { agentId: "main", sessionKey: entry.childSessionKey },
            { trackOwner: true, ownsContext: true },
          );
          assert(claim);
          claims.set(entry.runId, claim);
        }
      }
      markGatewayRestartDraining();
      global.gc!();
      if (values.allocation) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 1024,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.cpuUsage();
      const start = performance.now();
      await terminateLiveSubagentsForShutdown(resolver);
      const wallMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      const sampledBytes = values.allocation
        ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
            (sum, sample) => sum + sample.size,
            0,
          )
        : undefined;
      const interrupted = Array.from({ length: 16 }, (_, i) => subagentRuns.get(`shutdown-${i}`)!);
      assert(interrupted.every((entry) => entry.execution.outcome?.status === "error"));
      writeFileSync(
        values.output!,
        JSON.stringify(
          {
            sourceHash: hash("sha256", source),
            fixture,
            allocation: values.allocation,
            load: loadavg(),
            runs: rows.size,
            active: interrupted.length,
            wallMs,
            cpuMs: (used.user + used.system) / 1000,
            sampledBytes,
            requiredUnfinished: interrupted.filter(
              (entry) =>
                entry.completion?.required &&
                !entry.cleanupCompletedAt &&
                !entry.killReconciliation?.suppressTaskDelivery,
            ).length,
            outcomes: interrupted.map((entry) => ({
              reason: entry.endedReason,
              delivery: entry.delivery?.status,
              captured: entry.completion?.capturedAt !== undefined,
              cleanupCompleted: entry.cleanupCompletedAt !== undefined,
              suppressed: entry.killReconciliation?.suppressTaskDelivery === true,
            })),
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    },
  );
} finally {
  inspector.disconnect();
  for (const [runId, claim] of claims) {
    releaseAgentRunContext(runId, claim);
  }
  subagentRuns.clear();
  await closeOpenClawStateDatabaseAsync();
}
