/**
 * Embedded retry recovery ownership, without transport, backoff, or Gateway noise.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/same-model-retry-retention.ts
 *   --mode retention --attempts 15 --history 128 --image-bytes 32768
 * --mode timing|allocation --runs 200 measures 3,000 accepted retry recoveries.
 * --owner /absolute/path/attempt-recovery.ts selects an import-resolvable baseline.
 * --expect-released turns retention samples into a regression assertion.
 * Retention parses fresh image history before every attempt and samples after GC.
 * Timing/allocation reuse prepared independent snapshots so fixture creation is
 * excluded. Retry acceptance is fixed; real recovery and prompt-state owners run.
 * Run the unchanged script against both revisions. Heap is context; weak-reference
 * survivor counts prove retained fixture bytes. This is not Gateway/load evidence.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { createTestAdmittedRunContext } from "../../src/agents/admitted-run-context.test-support.js";
import type { recoverEmbeddedRunAttempt } from "../../src/agents/embedded-agent-runner/run/attempt-recovery.js";
import { createEmbeddedRunContextRecoveryState } from "../../src/agents/embedded-agent-runner/run/context-recovery-state.js";
import { normalizeEmbeddedRunAttemptResult } from "../../src/agents/embedded-agent-runner/run/run-attempt-result.js";
import { createEmbeddedRunSessionPromptState } from "../../src/agents/embedded-agent-runner/run/session-prompt-state.js";
import { resolveEmbeddedRunAttemptTerminalState } from "../../src/agents/embedded-agent-runner/run/terminal-outcome.js";
import { createUsageAccumulator } from "../../src/agents/embedded-agent-runner/usage-accumulator.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../src/agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "retention" },
    attempts: { type: "string", default: "15" },
    runs: { type: "string", default: "200" },
    history: { type: "string", default: "128" },
    "image-bytes": { type: "string", default: "32768" },
    "expect-released": { type: "boolean" },
  },
});
const mode = values.mode;
assert(["retention", "timing", "allocation"].includes(mode));
assert(!values["expect-released"] || mode === "retention", "--expect-released requires retention");
const attempts = Number(values.attempts);
const runs = Number(values.runs);
const history = Number(values.history);
const imageBytes = Number(values["image-bytes"]);
for (const value of [attempts, runs, history, imageBytes]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
assert(attempts <= 15, "The provider retry contract permits at most 15 retries");
assert(globalThis.gc, "Use --expose-gc");
const {
  recoverEmbeddedRunAttempt: recover,
}: { recoverEmbeddedRunAttempt: typeof recoverEmbeddedRunAttempt } = await import(
  values.owner
    ? pathToFileURL(values.owner).href
    : "../../src/agents/embedded-agent-runner/run/attempt-recovery.js"
);
const noop = () => {};
const unavailable = () => {
  throw new Error("Unexpected recovery branch in 429 fixture");
};
const assistant = buildEmbeddedRunnerAssistant({
  provider: "openai",
  model: "synthetic-responses",
  stopReason: "error",
  content: [],
  errorMessage: "429 Rate limit reached. Please retry.",
  errorCode: "rate_limit_exceeded",
});
const runParams = {
  admittedRunContext: createTestAdmittedRunContext("retry-retention"),
  runId: "retry-retention",
  agentId: "main",
  sessionId: "retry-retention",
  sessionKey: "agent:main:retry-retention",
  sessionFile: "agent:main:retry-retention",
  sessionPersistence: "detached" as const,
  sessionTarget: {
    agentId: "main",
    sessionId: "retry-retention",
    sessionKey: "agent:main:retry-retention",
    storePath: "/nonexistent/synthetic-retry-retention.sqlite",
  },
  workspaceDir: process.cwd(),
  prompt: "Continue the synthetic task.",
  timeoutMs: 30_000,
  config: {},
};
const serializedHistory = JSON.stringify(
  Array.from({ length: history }, (_, index): AgentMessage => ({
    role: "user",
    content: [
      { type: "text", text: `Synthetic image history ${index}.` },
      { type: "image", mimeType: "image/png", data: `${index}:`.padEnd(imageBytes, "a") },
    ],
    timestamp: index,
  })),
);
function snapshot(): AgentMessage[] {
  // The fixture is typed at construction and round-tripped exactly like stored history.
  return JSON.parse(serializedHistory) as AgentMessage[];
}
async function createState() {
  return createEmbeddedRunSessionPromptState({
    runParams,
    sessionAgentId: "main",
    resolvedSessionKey: runParams.sessionKey,
    lifecycleGeneration: "retry-retention",
    onInterrupt: unavailable,
  });
}
type PromptState = Awaited<ReturnType<typeof createState>>;
type RecoveryInput = Parameters<typeof recoverEmbeddedRunAttempt>[0];
async function attempt(state: PromptState, messages: AgentMessage[]) {
  const result = normalizeEmbeddedRunAttemptResult(
    makeEmbeddedRunnerAttempt({
      messagesSnapshot: [...messages, assistant],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { replaySafe: true, hadPotentialSideEffects: false },
    }),
  );
  // The fixture enters after attempt settlement. Unused runtime operations fail
  // loudly; only timer/policy acceptance is substituted to isolate retained state.
  const input = {
    runInput: {
      runParams,
      resolvedSessionKey: runParams.sessionKey,
      fallbackConfigured: false,
      startedAtMs: 0,
      laneController: { throwIfAborted: noop },
    },
    preparedRuntime: {
      provider: "openai",
      modelId: "synthetic-responses",
      model: { id: "synthetic-responses" },
      genericCompactionRecoveryAllowed: false,
      snapshot: () => ({
        thinkLevel: "off",
        agentHarness: { id: "openclaw" },
        outerContextTokenMeta: {},
        pluginHarnessOwnsTransport: false,
      }),
    },
    normalizedAttempt: {
      attempt: result,
      sessionIdUsed: runParams.sessionId,
      attemptAssistant: assistant,
      currentAttemptAssistant: assistant,
      assistantErrorText: assistant.errorMessage,
      terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt: result, assistant }),
      setTerminalLifecycleMeta: unavailable,
      attemptCompactionCount: 0,
      activeErrorContext: { provider: "openai", model: "synthetic-responses" },
      resolveReplayInvalidForAttempt: () => false,
      canRestartForLiveSwitch: false,
    },
    runtimePlan: { auth: {} },
    sessionPromptState: state,
    failoverRetryController: { maybeRetryTransient: async () => true },
    compactionRuntime: { prepareRecoveryOwner: unavailable, assertRecoveryActive: unavailable },
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    usageAccumulator: createUsageAccumulator(),
    runtimeAuthRetry: false,
    codexAppServerRecoveryRetryAvailable: false,
    codexAppServerRecoveryRetries: 0,
    lastRetryFailoverReason: null,
    traceAttempts: [],
    sessionAgentId: "main",
  };
  // This synthetic post-settlement fixture supplies only operations exercised by
  // accepted 429 recovery; it cannot run a provider, tool, or persistence effect.
  assert.equal((await recover(input as RecoveryInput)).action, "retry");
}
async function collect() {
  await nextTurn();
  globalThis.gc!();
  await nextTurn();
  globalThis.gc!();
}
const hostLoad = loadavg();
if (mode === "retention") {
  await using state = await createState();
  const references: WeakRef<AgentMessage>[] = [];
  const samples = [];
  await collect();
  const before = process.memoryUsage();
  for (let index = 0; index < attempts; index++) {
    await (async () => {
      const messages = snapshot();
      references.push(...messages.map((message) => new WeakRef(message)));
      await attempt(state, messages);
    })();
    await collect();
    const retainedMessages = references.filter((reference) => reference.deref()).length;
    samples.push({
      attempt: index + 1,
      retainedMessages,
      retainedImageBytes: retainedMessages * imageBytes,
      continuationMessages: state.continuation?.messages.length ?? 0,
      ...process.memoryUsage(),
    });
  }
  console.log(JSON.stringify({ mode, attempts, history, imageBytes, hostLoad, before, samples }));
  if (values["expect-released"]) {
    assert(
      samples.every((sample) => sample.retainedMessages === 0),
      "Completed embedded retries must release every previous history snapshot while the run is alive",
    );
  }
} else {
  const prepared = Array.from({ length: attempts }, () => snapshot());
  for (let warm = 0; warm < 5; warm++) {
    await using state = await createState();
    for (const messages of prepared) {
      await attempt(state, messages);
    }
  }
  await collect();
  const inspector = new Session();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  for (let run = 0; run < runs; run++) {
    await using state = await createState();
    for (const messages of prepared) {
      await attempt(state, messages);
    }
  }
  const cpu = process.threadCpuUsage(cpuStart);
  const wallMs = performance.now() - started;
  let sampledBytes: number | undefined;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  const operations = runs * attempts;
  console.log(
    JSON.stringify({
      mode,
      operations,
      history,
      imageBytes,
      hostLoad,
      hostLoadEnd: loadavg(),
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuUsPerAttempt: (cpu.user + cpu.system) / operations,
      sampledBytes,
      sampledBytesPerAttempt: sampledBytes === undefined ? undefined : sampledBytes / operations,
    }),
  );
}
