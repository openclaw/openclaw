/** Synthetic session-read-transactions fixture only; --expose-gc --import ./scripts/tsx.mjs.
 * Usage: <fixture> <baseline directory containing direct.ts/store.ts> <output> [control] [allocation]
 * Five alternating pairs after warmup; control runs the baseline in both arms.
 * Acceptance: one current-backend injection; expiry adds one visible notice, no new turn.
 * Setup/verification are outside owner wall/CPU/host-allocation measurements.
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
const sourceUrl = (file) => pathToFileURL(path.resolve(file)).href;
const { createGatewayBenchEnv } = await import("../lib/gateway-bench-runtime.ts");
Object.assign(
  process.env,
  createGatewayBenchEnv(root, path.join(root, "openclaw.json"), {
    caseEnv: { OPENCLAW_STATE_DIR: root },
  }),
);
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.ts");
setRuntimeConfigSnapshot(JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8")));
const sources = new Map();
const urls = [
  ["direct", "src/agents/subagents/announce/subagent-announce-direct-delivery.ts"],
  ["store", "src/agents/subagents/completion/subagent-completion-admission.store.ts"],
].map(([name, file]) =>
  [0, 1].map((arm) => {
    const url = `${sourceUrl(file)}?restart-measure=${arm}`;
    sources.set(
      url,
      readFileSync(arm && !control ? file : path.join(baseline, `${name}.ts`), "utf8"),
    );
    return url;
  }),
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
const direct = [await import(urls[0][0]), await import(urls[0][1])];
const store = [await import(urls[1][0]), await import(urls[1][1])];
const { loadRequesterSessionEntry } =
  await import("../../src/agents/subagents/announce/subagent-announce-delivery.runtime.ts");
const { reserveSubagentCompletionControllerSource } =
  await import("../../src/agents/subagents/announce/subagent-announce-controller-source.ts");
const { createReplyOperation } = await import("../../src/sessions/session-controller.operation.ts");
const { captureSessionTarget } = await import("../../src/sessions/session-controller.lifecycle.ts");
const { retireSessionControllerInput } =
  await import("../../src/sessions/session-controller.mailbox.ts");
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.ts");
const { bindSubagentRunRecord } =
  await import("../../src/agents/subagents/registry/subagent-registry.store.codec.ts");
const { writeSubagentRunValuesInDatabase } =
  await import("../../src/agents/subagents/registry/subagent-registry.store.kernel.ts");
const state = await import("../../src/state/openclaw-state-db.ts");
const agent = await import("../../src/state/openclaw-agent-db.ts");
const { loadTranscriptEvents } = await import("../../src/config/sessions/session-accessor.ts");
const database = state.openOpenClawStateDatabase();
console.log("restart delivery measurement: owners loaded");
const requesterSessionKey = "agent:main:lane2035-session-00001";
const requester = await loadRequesterSessionEntry(requesterSessionKey, "main");
assert(requester.entry);
console.log("restart delivery measurement: requester loaded");
const inspector = new Session();
if (allocation) {
  inspector.connect();
}
const results = [];
const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
try {
  for (const scenario of ["ready", "expiry"]) {
    for (let pair = -1; pair < 5; pair++) {
      for (const arm of pair % 2 ? [1, 0] : [0, 1]) {
        const trials = [];
        for (let iteration = 0; iteration < 20; iteration++) {
          const runId = `restart-measure-${randomUUID()}`;
          const entry = {
            runId,
            childSessionKey: `agent:main:subagent:${runId}`,
            requesterSessionKey,
            requesterAgentId: "main",
            requesterDisplayKey: "synthetic",
            requesterTurnRunId: "pre-restart",
            task: "synthetic",
            cleanup: "keep",
            createdAt: 1,
            expectsCompletionMessage: true,
            execution: {
              status: "terminal",
              endedAt: 2,
              outcome: { status: "error", error: "Gateway stopped" },
            },
            completion: { required: true, capturedAt: 2, resultText: "(no output)" },
            delivery: { status: "pending", generation: 1 },
          };
          let input,
            operation,
            injections = 0;
          if (scenario === "ready") {
            operation = createReplyOperation({
              sessionKey: requesterSessionKey,
              sessionId: requester.entry.sessionId,
              target: captureSessionTarget({
                storeScope: requester.storePath,
                physicalStorePath: requester.physicalStorePath,
                sessionKey: requesterSessionKey,
                agentId: "main",
                incarnation: requester.entry.sessionId,
              }),
              resetTriggered: false,
            });
            operation.setPhase("running");
            operation.attachBackend({
              kind: "embedded",
              runId: "restart-recovery",
              cancel() {},
              supportsTranscriptCommitWait: true,
              messageInjectionV2: {
                version: 2,
                isAvailable: () => true,
                queueMessage() {
                  assert.fail("Expected asynchronous authority preparation");
                },
                async queueMessageAsync(_text, options, preparation) {
                  await preparation.prepareCurrent();
                  injections++;
                  options?.onQueueAccepted?.(true);
                },
              },
            });
            input = await reserveSubagentCompletionControllerSource(entry);
            assert(input);
          } else {
            state.runOpenClawStateWriteTransaction(
              () => writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(entry)], []),
              { database },
            );
            subagentRuns.set(runId, entry);
          }
          global.gc();
          if (allocation) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 1024,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const cpu = process.cpuUsage();
          const start = performance.now();
          const result =
            scenario === "ready"
              ? await direct[arm].sendSubagentAnnounceDirectly({
                  requesterSessionKey,
                  requesterAgentId: "main",
                  targetRequesterSessionKey: requesterSessionKey,
                  triggerMessage: "Child interrupted by Gateway restart",
                  sourceSessionKey: entry.childSessionKey,
                  sourceTool: "subagent_announce",
                  requesterIsSubagent: false,
                  expectsCompletionMessage: true,
                  directIdempotencyKey: runId,
                  controllerInput: input,
                  signal: AbortSignal.timeout(10000),
                })
              : await store[arm].blockSubagentCompletionDelivery({
                  subagent: entry,
                  reason: "synthetic expiry",
                  suspendedReason: "expiry",
                  databaseOptions: { database },
                });
          const wallMs = performance.now() - start;
          const used = process.cpuUsage(cpu);
          const sampledBytes = allocation
            ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
            : undefined;
          if (scenario === "ready") {
            assert.deepEqual(result, { delivered: true, path: "steered" });
            assert.equal(injections, 1);
            operation.complete();
            retireSessionControllerInput(input);
          } else {
            assert.equal(result, true);
            const events = await loadTranscriptEvents({
              agentId: "main",
              sessionKey: requesterSessionKey,
              sessionId: requester.entry.sessionId,
            });
            const notices = events.filter((event) => event.details?.childRunId === runId);
            assert.deepEqual(
              notices.map((event) => event.customType),
              arm && !control ? ["subagent-delivery-delayed"] : [],
            );
          }
          trials.push({
            wallMs,
            cpuMs: (used.user + used.system) / 1000,
            sampledBytes,
            injections,
          });
        }
        results.push({ scenario, pair, arm, hostLoad: loadavg(), trials });
        console.log(JSON.stringify({ scenario, pair, arm, trials: trials.length }));
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
        sources: [...sources.values()].map((source) =>
          createHash("sha256").update(source).digest("hex"),
        ),
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
