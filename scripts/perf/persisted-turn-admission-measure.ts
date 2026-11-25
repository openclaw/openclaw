/**
 * Real SQLite replay-owner measurement against an offline team-shape fixture.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/persisted-turn-admission-measure.ts
 *   --state-dir <synthetic-team-shape-dir> --output <new-json> [--baseline-dir <overlay>]
 * Use --race for one real metadata append between selection and admission.
 * Use frozen owner overlays in both arms so loader instrumentation is identical.
 * Run two A/A controls and five interleaved A/B pairs, separately with --allocation.
 * Acceptance: unchanged-path cost stays within A/A spread; raced admission succeeds
 * exactly once with one refresh and one persisted user. Recovery costs are required
 * extra work, not a latency speedup over the baseline's failed turn.
 * No live provider, Gateway, production data, or filesystem-pressure claim.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    iterations: { type: "string", default: "20" },
    race: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"] && values.output);
const stateDir = path.resolve(values["state-dir"]);
const fixture = JSON.parse(readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), path.join(stateDir, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: stateDir,
};
if (values["baseline-dir"]) {
  const owner = "src/agents/embedded-agent-runner/run/pre-persisted-user-turn.ts";
  const original = new URL(`../../${owner}`, import.meta.url).href;
  const replacement = pathToFileURL(path.resolve(values["baseline-dir"], owner)).href;
  registerHooks({
    load(url, context, nextLoad) {
      return nextLoad(url === original ? replacement : url, context);
    },
  });
}
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const currentTurn = await import("../../src/agents/sessions/session-manager-current-turn.js");
const selectKey: typeof currentTurn.sessionManagerPrepareCurrentTurnReplay =
  currentTurn.sessionManagerPrepareCurrentTurnReplay;
const { preparePersistedCurrentUserTurn } =
  await import("../../src/agents/embedded-agent-runner/run/pre-persisted-user-turn.js");
const { guardSessionManager } =
  await import("../../src/agents/session-tool-result-guard-wrapper.js");
const { createUserTurnTranscriptRecorder } =
  await import("../../src/sessions/user-turn-transcript.js");
const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
const { withOwnedSessionTranscriptWrites } =
  await import("../../src/config/sessions/transcript-write-context.js");
const { createEmbeddedAttemptTranscriptLifecycle } =
  await import("../../src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const sessionId = `replay-admission-bench-${randomUUID()}`;
const target = {
  agentId: "main",
  storePath: path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"),
  sessionId,
  sessionKey: `agent:main:${sessionId}`,
  expectedLifecycleRevision: "synthetic-replay",
  expectedWriterRunId: "synthetic-replay",
};
await upsertSessionEntryCore(target, {
  sessionId: target.sessionId,
  updatedAt: 1,
  lifecycleRevision: target.expectedLifecycleRevision,
  activeWriterRunId: target.expectedWriterRunId,
});
const input = {
  text: "Continue this synthetic request",
  timestamp: 1,
  idempotencyKey: "replay-bench",
};
const recorder = createUserTurnTranscriptRecorder({
  target: { ...target, sessionEntry: undefined },
  input,
});
await recorder.stageApproved!({ runId: target.expectedWriterRunId, assertCurrent: () => {} });
const message = await recorder.resolveMessage();
assert(message);
const writer = guardSessionManager(await SessionManager.openAsync(target), {
  runId: target.expectedWriterRunId,
  preparedUserTurnMessage: message,
  preparedUserTurnTranscriptRecorder: recorder,
});
await recorder.withPendingInput!(() => writer.appendMessageAsync(message));
recorder.releasePendingInput!();
const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ runId: target.expectedWriterRunId });
const manager = await SessionManager.openAsync(target);
const nativeSelect = manager[selectKey].bind(manager);
let selections = 0;
manager[selectKey] = async (...args) => {
  const selection = await nativeSelect(...args);
  selections++;
  if (values.race && selections === 1) {
    await writer.reloadPersistedTranscriptAsync();
    await writer.appendThinkingLevelChange("high");
  }
  return selection;
};
const inspector = new Session();
const samples = [];
try {
  for (let index = -1; index < iterations; index++) {
    selections = 0;
    let admitted = 0;
    let failure: string | undefined;
    global.gc?.();
    if (values.allocation) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpu = process.cpuUsage();
    const threadCpu = process.threadCpuUsage();
    const started = performance.now();
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        assertCommitAllowed: () => {},
        withTranscriptWrite: (write) => lifecycle.withTranscriptWrite(write),
      },
      async () => {
        try {
          const prepare = await preparePersistedCurrentUserTurn({
            sessionManager: manager,
            message,
            recorder,
            runId: target.expectedWriterRunId,
          });
          assert.equal(typeof prepare, "function");
          if (typeof prepare === "function") {
            const consume = await prepare();
            assert(consume);
            await consume(() => admitted++);
            assert.equal(await prepare(), undefined);
          }
        } catch (error) {
          assert(error instanceof Error);
          assert.match(error.name, /^Session(?:TranscriptReadFence|WorkStartChanged)Error$/);
          failure = error.name;
        }
      },
    );
    const elapsedMs = performance.now() - started;
    const usage = process.cpuUsage(cpu);
    const threadUsage = process.threadCpuUsage(threadCpu);
    let allocatedBytes: number | undefined;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      inspector.disconnect();
    }
    assert.equal(admitted, failure ? 0 : 1);
    await manager.reloadPersistedTranscriptAsync();
    assert.equal(
      manager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user").length,
      1,
    );
    samples.push({
      cold: index === -1,
      elapsedMs,
      selections,
      admitted,
      failure,
      allocatedBytes,
      cpuMs: (usage.user + usage.system) / 1000,
      threadCpuMs: (threadUsage.user + threadUsage.system) / 1000,
    });
  }
  const result = {
    node: process.version,
    race: values.race,
    allocation: values.allocation,
    ownerSha256: createHash("sha256")
      .update(
        readFileSync(
          path.resolve(
            values["baseline-dir"] ?? ".",
            "src/agents/embedded-agent-runner/run/pre-persisted-user-turn.ts",
          ),
        ),
      )
      .digest("hex"),
    fixture,
    databaseBytes: statSync(target.storePath).size,
    hostLoad: loadavg(),
    samples,
  };
  writeFileSync(values.output, JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify(result));
} finally {
  recorder.finishPendingInput!("interrupted", "failed");
  await lifecycle.dispose();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
