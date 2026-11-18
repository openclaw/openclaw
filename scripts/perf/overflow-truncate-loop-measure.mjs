/**
 * Synthetic overflow recovery owner; no network, credentials, or production data.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/overflow-truncate-loop-measure.mjs
 *   --root <checkout> --expect exhausted|compact --mode timing|allocation --iterations 5
 * Compare fresh processes in A/A and alternating A/B order. The fixture is the active
 * million-token request. --state-dir uses a completed synthetic team-shape database
 * for real transcript rewrites; workspace preparation is outside this owner.
 * Submission growth is covered by attempt-prompt-submit.test.ts through the real session.
 */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    expect: { type: "string", default: "compact" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "5" },
    "state-dir": { type: "string" },
  },
});
assert.ok(global.gc, "Use --expose-gc");
assert.ok(["exhausted", "compact"].includes(values.expect));
assert.ok(["timing", "allocation"].includes(values.mode));
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
const source = (file) => import(pathToFileURL(path.resolve(values.root, file)).href);
const stateDir = values["state-dir"] && path.resolve(values["state-dir"]);
let fixture;
if (stateDir) {
  fixture = JSON.parse(await readFile(path.join(stateDir, "team-shape-summary.json"), "utf8"));
  assert.equal(fixture.format, "openclaw-team-shape-v1");
  assert.ok(fixture.agentDatabaseBytes > 0 && fixture.generationMs > 0);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
}
const { SessionManager } = await source("src/agents/sessions/session-manager.ts");
const { handleEmbeddedAttemptMidTurnPrecheck } = await source(
  "src/agents/embedded-agent-runner/run/attempt-prompt-preflight.ts",
);
const { shouldPreemptivelyCompactBeforePrompt } = await source(
  "src/agents/embedded-agent-runner/run/preemptive-compaction.ts",
);
const { estimateToolResultReductionPotential, projectToolResultMessages } = await source(
  "src/agents/embedded-agent-runner/tool-result-truncation.ts",
);
const { createToolResultPromptProjectionState } = await source(
  "src/agents/embedded-agent-runner/session-prompt-state.ts",
);
const { beginRunAttempt, createRunRetryBudget, isRunRetryBudgetExhausted } = await source(
  "src/agents/embedded-agent-runner/run/retry-budget.ts",
);
const settleRewrites = stateDir
  ? (await source("src/config/sessions/session-transcript-reconcile.ts"))
      .waitForSessionTranscriptIndexReconcilesInStateDir
  : async () => {};
if (stateDir) {
  // Complete verification before warm-up, so a cold integrity scan cannot
  // contaminate the measured recovery CPU or leave an unverified close.
  const { openOpenClawAgentDatabase } = await source("src/state/openclaw-agent-db.js");
  const { readSqliteDatabaseIntegrityVerification } = await source(
    "src/infra/sqlite-database-admission.js",
  );
  const { assertSqliteIntegrity } = await source("src/infra/sqlite-integrity.js");
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  if (!readSqliteDatabaseIntegrityVerification(database.db)) {
    assertSqliteIntegrity(database.db, "synthetic overflow fixture", { check: "full" });
  }
}
const history = Array.from({ length: 768 }, (_, index) => ({
  role: "user",
  content: `Synthetic history ${index}: ${"retain the current task ".repeat(180)}`,
  timestamp: index,
}));
const projected = {
  role: "toolResult",
  toolCallId: "synthetic-result",
  toolName: "read",
  isError: false,
  content: [{ type: "text", text: "synthetic tool output ".repeat(25_000) }],
  timestamp: 769,
};
const messages = [...history, projected];
const budgets = { contextWindowTokens: 1_000_000, maxCharsOverride: 64_000 };
let nextRun = 0;
const makeRun = async () => {
  let sessionManager;
  if (stateDir) {
    const { upsertSessionEntryCore } = await source("src/config/sessions/session-accessor.ts");
    const { replaceTranscriptEvents } = await source(
      "src/config/sessions/session-accessor.sqlite-transcript-write.test-support.ts",
    );
    // Replace the same task-owned slots across processes, keeping fixture size fixed.
    const sessionId = `overflow-measure-${nextRun++}`;
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:overflow-measure:${sessionId}`,
      storePath: path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents(target, [
      { type: "session", id: sessionId, version: 3, cwd: path.join(stateDir, "workspace") },
      ...messages.map((message, index) => ({
        type: "message",
        id: `event-${index}`,
        parentId: index ? `event-${index - 1}` : null,
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
        message,
      })),
    ]);
    sessionManager = await SessionManager.openAsync(target);
  } else {
    sessionManager = SessionManager.inMemory();
    for (const message of messages) {
      await sessionManager.appendMessageAsync(message);
    }
  }
  const projectionState = createToolResultPromptProjectionState();
  return async () => {
    const budget = createRunRetryBudget(32);
    let route;
    while (!isRunRetryBudgetExhausted(budget)) {
      beginRunAttempt(budget);
      const request = shouldPreemptivelyCompactBeforePrompt({
        messages,
        contextTokenBudget: budgets.contextWindowTokens,
        reserveTokens: 78_000,
        prompt: "",
        toolResultMaxChars: budgets.maxCharsOverride,
        llmBoundaryTokenPressure: { estimatedPromptTokens: 932_476, source: "synthetic-rendered" },
        estimateRecoverableToolResultChars: () =>
          estimateToolResultReductionPotential({
            ...budgets,
            messages: projectToolResultMessages({
              messages: sessionManager.buildSessionContext().messages,
              projectionState,
              recovering: true,
            }).messages,
          }).maxReducibleChars,
      });
      const outcome = await handleEmbeddedAttemptMidTurnPrecheck({
        attempt: {
          provider: "fixture",
          modelId: "synthetic",
          sessionId: "overflow-measure",
          contextTokenBudget: budgets.contextWindowTokens,
        },
        request,
        sessionAgentId: "fixture",
        sessionManager,
        toolResultPromptProjectionState: projectionState,
        prePromptMessageCount: messages.length,
        replaceSessionMessages: () => {},
      });
      route = outcome.preflightRecovery.route;
      if (outcome.promptError) {
        break;
      }
    }
    assert.equal(budget.attemptsDispatched, values.expect === "compact" ? 2 : 32);
    assert.equal(
      route,
      values.expect === "compact" ? "compact_only" : "truncate_tool_results_only",
    );
    await settleRewrites(stateDir);
    return budget.attemptsDispatched;
  };
};
await (
  await makeRun()
)();
const samples = [];
let totalCpu = 0;
let totalProcessCpu = 0;
let totalAllocation = 0;
let prechecks = 0;
const hostLoad = loadavg();
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
}
for (let iteration = 0; iteration < iterations; iteration++) {
  const run = await makeRun();
  global.gc();
  if (values.mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.threadCpuUsage();
  const processCpu = process.cpuUsage();
  const start = performance.now();
  prechecks += await run();
  samples.push(performance.now() - start);
  const used = process.threadCpuUsage(cpu);
  totalCpu += (used.user + used.system) / 1000;
  const processUsed = process.cpuUsage(processCpu);
  totalProcessCpu += (processUsed.user + processUsed.system) / 1000;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = (node) =>
      node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
    totalAllocation += bytes(profile.head);
  }
}
if (values.mode === "allocation") {
  inspector.disconnect();
}
if (stateDir) {
  const { closeOpenClawAgentDatabasesAsync } = await source("src/state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseAsync } = await source("src/state/openclaw-state-db.js");
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  const { drainGlobalSingletonLifecycleState } = await source("src/shared/global-singleton.ts");
  await drainGlobalSingletonLifecycleState();
}
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    outcome: values.expect,
    mode: values.mode,
    iterations,
    hostLoad,
    fixtureMessages: messages.length,
    fixtureBytes: Buffer.byteLength(JSON.stringify(messages)),
    durableFixture: stateDir
      ? {
          sessions: fixture.sessionCount,
          databaseBytes: (
            await stat(path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"))
          ).size,
        }
      : undefined,
    estimatedPromptTokens: 932_476,
    promptBudget: 922_000,
    prechecksPerOperation: prechecks / iterations,
    samples,
    p50Ms: samples[Math.ceil(iterations * 0.5) - 1],
    p95Ms: samples[Math.ceil(iterations * 0.95) - 1],
    cpuMsPerOperation: totalCpu / iterations,
    processCpuMsPerOperation: totalProcessCpu / iterations,
    ...(values.mode === "allocation"
      ? { allocatedBytesPerOperation: totalAllocation / iterations }
      : {}),
  }),
);
