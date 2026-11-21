/** Synthetic team-shape fixture; --expose-gc --import ./scripts/tsx.mjs.
 * <fixture> <output.json> <baseline|candidate> <baseline overlay directory|-> [allocation]
 * Run five interleaved A/A/B rounds. Setup and verification are excluded.
 * Measures the actual sweeper/expiry owner with 100 live requester operations.
 * The baseline incorrectly discards the live wait; candidate must retain it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [fixture, output, arm, overlay, mode] = process.argv.slice(2);
assert(fixture && output && global.gc && ["baseline", "candidate"].includes(arm));
assert(!existsSync(output));
const summary = JSON.parse(readFileSync(path.join(fixture, "team-shape-summary.json"), "utf8"));
assert.equal(summary.format, "openclaw-team-shape-v1");
const root = process.cwd();
if (overlay !== "-") {
  registerHooks({
    load(url, context, next) {
      if (url.startsWith("file:")) {
        const relative = path.relative(root, fileURLToPath(url));
        const source = path.join(overlay, relative);
        if (!relative.startsWith("..") && existsSync(source)) {
          return {
            format: "module-typescript",
            source: readFileSync(source, "utf8"),
            shortCircuit: true,
          };
        }
      }
      return next(url, context);
    },
  });
}
const { createGatewayBenchEnv } = await import("../lib/gateway-bench-runtime.ts");
Object.assign(
  process.env,
  createGatewayBenchEnv(fixture, path.join(fixture, "openclaw.json"), {
    caseEnv: { OPENCLAW_STATE_DIR: fixture, NODE_ENV: "test" },
  }),
);
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.ts");
setRuntimeConfigSnapshot(JSON.parse(readFileSync(path.join(fixture, "openclaw.json"), "utf8")));
await import("../../src/agents/subagents/registry/subagent-registry.ts");
const registry = globalThis[Symbol.for("openclaw.subagentRegistryTestApi")];
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.ts");
const { mutateSubagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-persistence.ts");
const { createReplyOperation } = await import("../../src/sessions/session-controller.operation.ts");
const { captureSessionTarget } = await import("../../src/sessions/session-controller.lifecycle.ts");
const { resolveSessionStorePathCore } = await import("../../src/config/sessions/paths.ts");
const { upsertSessionEntryCore, loadTranscriptEvents } =
  await import("../../src/config/sessions/session-accessor.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.ts");
const target = {
  agentId: "main",
  sessionKey: "agent:main:expiry-measure",
  sessionId: `expiry-${randomUUID()}`,
  storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
};
await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: Date.now() });
const operations = Array.from({ length: 100 }, (_, i) => {
  const ref = {
    ...target,
    sessionKey: i === 99 ? target.sessionKey : `agent:main:expiry-background-${i}`,
    sessionId: i === 99 ? target.sessionId : `background-${i}`,
  };
  const operation = createReplyOperation({
    ...ref,
    resetTriggered: false,
    target: captureSessionTarget({ ...ref, incarnation: ref.sessionId, storeScope: ref.storePath }),
  });
  operation.attachBackend({ kind: "embedded", runId: `expiry-blocker-${i}`, cancel() {} });
  operation.setPhase("running");
  return operation;
});
const inspector = new Session();
const allocation = mode === "allocation";
if (allocation) {
  inspector.connect();
}
const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
const trials = [];
try {
  for (let i = -3; i < 20; i++) {
    const runId = `expiry-child-${randomUUID()}`;
    const endedAt = Date.now() - 31 * 60_000;
    const entry = {
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      childAgentId: "main",
      requesterSessionKey: target.sessionKey,
      requesterAgentId: "main",
      requesterStorePath: target.storePath,
      requesterTurnRunId: "expiry-blocker-99",
      requesterDisplayKey: "synthetic",
      task: "Synthetic expiry result",
      cleanup: "keep",
      createdAt: endedAt - 1000,
      expectsCompletionMessage: true,
      execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
      completion: {
        required: true,
        capturedAt: endedAt,
        resultText: "Synthetic retained child answer",
      },
      delivery: {
        status: "pending",
        generation: 1,
        requesterDelivery: { state: "waiting", blockingRunId: "expiry-blocker-99" },
      },
    };
    await mutateSubagentRuns([runId], () => ({
      value: undefined,
      postimages: new Map([[runId, entry]]),
    }));
    global.gc();
    if (allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const before = process.cpuUsage();
    const start = performance.now();
    await registry.testing.sweepOnceForTests();
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(before);
    const sampledBytes = allocation
      ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
    assert.equal(
      subagentRuns.get(runId)?.delivery?.status,
      arm === "candidate" ? "pending" : "discarded",
    );
    const events = await loadTranscriptEvents(target);
    assert.equal(
      events.filter((event) => event.details?.childRunId === runId).length,
      arm === "candidate" ? 0 : 1,
    );
    if (i >= 0) {
      trials.push({ wallMs, cpuMs: (cpu.user + cpu.system) / 1000, sampledBytes });
    }
    await mutateSubagentRuns([runId], () => ({
      value: undefined,
      postimages: new Map([[runId, null]]),
    }));
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        arm,
        mode,
        node: process.version,
        summary,
        activeOperations: operations.length,
        hostLoad: loadavg(),
        trials,
      },
      null,
      2,
    ),
  );
} finally {
  for (const operation of operations) {
    operation.complete();
  }
  inspector.disconnect();
  await registry.resetSubagentRegistryForTests({ persist: false });
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
