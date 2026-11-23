/** Synthetic fixture only. Usage with --expose-gc --import ./scripts/tsx.mjs:
 * <fixture> <baseline store.ts> <output.json> [control] [allocation]
 * Alternating A/A or A/B pairs; setup and acceptance checks are outside measurement.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, baseline, output, ...flags] = process.argv.slice(2);
assert(root && baseline && output && global.gc && !existsSync(output));
const control = flags.includes("control");
const allocation = flags.includes("allocation");
const fixture = JSON.parse(readFileSync(path.join(root, "fixture.json"), "utf8"));
assert.equal(fixture.format, "openclaw-session-read-transactions-v1");
const { createGatewayBenchEnv } = await import("../lib/gateway-bench-runtime.ts");
Object.assign(
  process.env,
  createGatewayBenchEnv(root, path.join(root, "openclaw.json"), {
    caseEnv: { OPENCLAW_STATE_DIR: root },
  }),
);
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.ts");
setRuntimeConfigSnapshot(JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8")));
const storePath = "src/agents/subagents/completion/subagent-completion-admission.store.ts";
const sources = new Map(
  [0, 1].map((arm) => [
    `${pathToFileURL(path.resolve(storePath)).href}?visible-result-arm=${arm}`,
    readFileSync(arm && !control ? storePath : baseline, "utf8"),
  ]),
);
registerHooks({
  load(url, context, next) {
    return sources.has(url)
      ? {
          format: "module",
          shortCircuit: true,
          source: stripTypeScriptTypes(sources.get(url), { sourceUrl: url }),
        }
      : next(url, context);
  },
});
const stores = await Promise.all([...sources.keys()].map((url) => import(url)));
const { settleConsumedRequesterDelivery } =
  await import("../../src/agents/subagents/completion/subagent-completion-settlement.ts");
const { resolveRequesterDeliveryOutcome } =
  await import("../../src/agents/subagents/registry/subagent-delivery-state.ts");
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.ts");
const { bindSubagentRunRecord } =
  await import("../../src/agents/subagents/registry/subagent-registry.store.codec.ts");
const { writeSubagentRunValuesInDatabase } =
  await import("../../src/agents/subagents/registry/subagent-registry.store.kernel.ts");
const { loadTranscriptEvents, loadSessionEntry } =
  await import("../../src/config/sessions/session-accessor.ts");
const state = await import("../../src/state/openclaw-state-db.ts");
const agent = await import("../../src/state/openclaw-agent-db.ts");
const database = state.openOpenClawStateDatabase();
const requesterSessionKey = "agent:main:lane2035-session-00001";
const scope = { agentId: "main", sessionKey: requesterSessionKey };
const requester = loadSessionEntry(scope);
assert(requester?.sessionId);
const results = [];
const inspector = new Session();
if (allocation) {
  inspector.connect();
}
const sampledSize = (node) =>
  node.selfSize + node.children.reduce((total, child) => total + sampledSize(child), 0);
try {
  for (const scenario of ["consumed-yield", "unconsumed-abort"]) {
    for (let pair = -1; pair < 5; pair++) {
      for (const arm of pair % 2 ? [1, 0] : [0, 1]) {
        const trials = [];
        for (let iteration = 0; iteration < 10; iteration++) {
          const runId = `visible-result-${randomUUID()}`;
          const consumed = scenario === "consumed-yield";
          const entry = {
            runId,
            taskRunId: runId,
            childSessionKey: `agent:main:subagent:${runId}`,
            childAgentId: "main",
            requesterSessionKey,
            requesterAgentId: "main",
            requesterDisplayKey: "synthetic",
            task: "synthetic restart outcome",
            cleanup: "delete",
            createdAt: 1,
            expectsCompletionMessage: true,
            execution: {
              status: "terminal",
              endedAt: 2,
              outcome: { status: "error", error: "Gateway stopped" },
            },
            completion: {
              required: true,
              capturedAt: 2,
              resultText: "Saved synthetic result & <markup>\n".repeat(32),
            },
            delivery: {
              status: "pending",
              generation: 1,
              ...(consumed
                ? { requesterDelivery: { state: "consumed", runId: "announcing-turn", at: 3 } }
                : {}),
            },
            requesterSettleWake: {
              status: "dispatching",
              attemptCount: 1,
              retireAfterSettle: true,
            },
          };
          state.runOpenClawStateWriteTransaction(
            () => writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(entry)], []),
            { database },
          );
          subagentRuns.set(runId, entry);
          const outcome = {
            delivered: false,
            path: "direct",
            reason: consumed ? "visible_reply_missing" : "requester_aborted",
            disposition: "permanent_failure",
          };
          global.gc();
          if (allocation) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 1024,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const cpu = process.cpuUsage();
          const started = performance.now();
          const result = consumed
            ? await (arm && !control
                ? settleConsumedRequesterDelivery([entry], outcome)
                : resolveRequesterDeliveryOutcome([entry], outcome))
            : await stores[arm].mutateRequesterCompletionBatch({
                entries: [entry],
                operation: { kind: "settle", outcome },
                assertCurrent() {},
                databaseOptions: { database },
              });
          const wallMs = performance.now() - started;
          const used = process.cpuUsage(cpu);
          const sampledBytes = allocation
            ? sampledSize((await inspector.post("HeapProfiler.stopSampling")).profile.head)
            : undefined;
          assert(consumed ? result.delivered : result.applied);
          const notices = (
            await loadTranscriptEvents({ ...scope, sessionId: requester.sessionId })
          ).filter((event) => event.details?.childRunId === runId);
          assert.equal(notices.length, consumed && !(arm && !control) ? 0 : 1);
          if (arm && !control) {
            assert(notices[0].content.includes(entry.childSessionKey));
            assert(notices[0].content.includes("Gateway restart"));
            if (consumed) {
              assert(notices[0].content.includes(entry.completion.resultText.trim()));
            }
          }
          trials.push({ wallMs, cpuMs: (used.user + used.system) / 1000, sampledBytes });
          state.runOpenClawStateWriteTransaction(
            () => writeSubagentRunValuesInDatabase(database, [], [runId]),
            { database },
          );
          subagentRuns.delete(runId);
        }
        results.push({ scenario, pair, arm, hostLoad: loadavg(), trials });
        console.log(JSON.stringify({ scenario, pair, arm, count: trials.length }));
      }
    }
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        fixture,
        control,
        allocation,
        node: process.version,
        sourceHashes: [...sources.values()].map((source) =>
          createHash("sha256").update(source).digest("hex"),
        ),
        noticeHash: createHash("sha256")
          .update(
            readFileSync("src/agents/subagents/completion/subagent-completion-admission.store.ts"),
          )
          .digest("hex"),
        results,
      },
      null,
      2,
    ),
  );
} finally {
  if (allocation) {
    inspector.disconnect();
  }
  subagentRuns.clear();
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}
