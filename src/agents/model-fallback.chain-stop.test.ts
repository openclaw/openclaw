import { afterAll, afterEach, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { testApi as loggerTestApi } from "../logging/logger.test-support.js";
import { loggingState } from "../logging/state.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { AgentRunTerminalOutcomeError } from "./agent-run-terminal-error.js";
import { abortable } from "./embedded-agent-runner/run/abortable.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./embedded-agent-runner/run/terminal-outcome.js";
import { resolveEmbeddedRunTerminalTimeout } from "./embedded-agent-runner/run/terminal-timeout.js";
import { FailoverError } from "./failover-error.js";
import { AgentHarnessPreflightError } from "./harness/errors.js";
import { type ModelFallbackStepHandler, runFallbackAttempt } from "./model-fallback-attempt.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import {
  createSessionPlacementSettlementClosedAbortError,
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "./run-termination.js";
import { toSandboxProvisioningError } from "./sandbox/provisioning-error.js";
import { makeEmbeddedRunnerAttempt } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

vi.mock("../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: () => undefined,
}));

const fallbackOptions = {
  cfg: undefined,
  provider: "fixture-primary",
  model: "fixture-model",
  manifestPlugins: [],
  fallbacksOverride: ["fixture-next/fixture-model"],
  sessionId: "chain-stop-session",
  lane: "chain-stop-lane",
};
const imageModel = {
  primary: "fixture-primary/fixture-model",
  fallbacks: fallbackOptions.fallbacksOverride,
};
const logPaths = createSuiteLogPathTracker("openclaw-chain-stop-");
const warn = vi.fn<(...data: unknown[]) => void>();
let capture: ReturnType<typeof createDiagnosticLogRecordCapture>;
let previousConsole: typeof loggingState.rawConsole;
let laneSequence = 0;
beforeAll(() => logPaths.setup());
afterAll(() => logPaths.cleanup());
beforeEach(() => {
  capture = createDiagnosticLogRecordCapture();
  previousConsole = loggingState.rawConsole;
  warn.mockClear();
  loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  setLoggerOverride({
    level: "warn",
    consoleLevel: "warn",
    consoleStyle: "compact",
    file: logPaths.nextPath(),
  });
});
afterEach(async () => {
  await capture.flush();
  await loggerTestApi.flushFileLogQueueForTests();
  capture.cleanup();
  loggingState.rawConsole = previousConsole;
  setLoggerOverride(null);
  resetLogger();
});
function fallbackRecords() {
  return capture.records.filter(
    (record) =>
      record.attributes?.event === "model_fallback_chain_stopped" ||
      record.attributes?.event === "model_fallback_decision",
  );
}
function terminalTimeout() {
  return new AgentRunTerminalOutcomeError(new Error("private timeout detail"), {
    status: "timeout",
    reason: "hard_timeout",
    timeoutPhase: "provider",
    providerStarted: true,
  });
}
async function commandLaneTimeout(): Promise<Error> {
  const entered = createDeferred();
  const task = createDeferred();
  const release = new AbortController();
  const queued = enqueueCommandInLane(
    `chain-stop-owned-${++laneSequence}`,
    async () => {
      entered.resolve();
      await task.promise;
    },
    { taskTimeoutMs: 60_000, taskTimeoutReleaseSignal: release.signal },
  );
  const failure = queued.catch((error: unknown) => error);
  try {
    await entered.promise;
    release.abort();
    const error = await failure;
    assert(error instanceof Error);
    expect(error.name).toBe("CommandLaneTaskTimeoutError");
    return error;
  } finally {
    task.resolve();
    await task.promise;
  }
}
async function terminalAbortWrapper(): Promise<Error> {
  const reason = new Error("private wrapper detail");
  reason.name = "TimeoutError";
  const controller = new AbortController();
  controller.abort(reason);
  const error = await abortable(controller.signal, Promise.resolve()).catch(
    (failure: unknown) => failure,
  );
  assert(error instanceof Error);
  return error;
}
type StopInput = { error: Error | { message: string }; abortSignal?: AbortSignal };
const stopCases: Array<{
  reason: string;
  make: () => StopInput | Promise<StopInput>;
  image?: boolean;
}> = [
  { reason: "agent_run_terminal_timeout", make: () => ({ error: terminalTimeout() }) },
  {
    reason: "command_lane_task_timeout",
    make: async () => ({ error: await commandLaneTimeout() }),
  },
  {
    reason: "agent_harness_preflight",
    make: () => ({ error: new AgentHarnessPreflightError("private preflight detail") }),
    image: true,
  },
  {
    reason: "sandbox_provisioning",
    make: () => ({
      error: toSandboxProvisioningError(new Error("private sandbox detail"), "fixture"),
    }),
  },
  {
    reason: "caller_signal_aborted",
    make: () => ({ error: { message: "private caller detail" }, abortSignal: AbortSignal.abort() }),
  },
  { reason: "agent_run_direct_abort", make: () => ({ error: createAgentRunDirectAbortError() }) },
  { reason: "agent_run_restart_abort", make: () => ({ error: createAgentRunRestartAbortError() }) },
  {
    reason: "session_placement_settlement_closed",
    make: () => ({ error: createSessionPlacementSettlementClosedAbortError() }),
  },
  { reason: "terminal_abort_wrapper", make: async () => ({ error: await terminalAbortWrapper() }) },
];

it("preserves an idle-breaker result without reporting fallback success or trying another model", async () => {
  const terminalResult = { modelFallbackStopReason: "idle_timeout_circuit_breaker" };
  const run = vi
    .fn()
    .mockRejectedValueOnce(new FailoverError("fixture failure", { reason: "format" }))
    .mockResolvedValueOnce(terminalResult);
  const result = await runWithModelFallback({
    ...fallbackOptions,
    fallbacksOverride: ["fixture-next/fixture-model", "fixture-last/fixture-model"],
    run,
    classifyResult: () => ({ stopReason: "idle_timeout_circuit_breaker" }),
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(result.result).toBe(terminalResult);
  await capture.flush();
  const records = fallbackRecords();
  expect(records).toHaveLength(2);
  expect(records[0]?.attributes?.decision).toBe("candidate_failed");
  expect(records[1]?.attributes).toMatchObject({
    event: "model_fallback_chain_stopped",
    reason: "idle_timeout_circuit_breaker",
    candidateProvider: "fixture-next",
    candidateModel: "fixture-model",
  });
});

it("does not attribute a returned timeout to a deduplicated single-candidate chain", async () => {
  const attempt = makeEmbeddedRunnerAttempt({
    terminal: { kind: "timeout", phase: "prompt", source: "run_budget", aborted: true },
  });
  const run = vi.fn(async () =>
    resolveEmbeddedRunTerminalTimeout({
      terminalPrepared: {
        timedOutDuringPrompt: true,
        hasSuccessfulFinalAssistantAfterPromptTimeout: false,
        hasPartialAssistantTextAfterPromptTimeout: false,
        payloads: [],
        payloadsWithToolMedia: [],
        agentMeta: {
          sessionId: "chain-stop-session",
          provider: "runtime-provider",
          model: "runtime-model",
        },
        attemptToolSummary: undefined,
        failureSignal: undefined,
      },
      attempt,
      terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant: undefined }),
      resolveReplayInvalid: () => false,
      setTerminalLifecycleMeta: vi.fn(),
      startedAtMs: Date.now(),
    }),
  );
  const result = await runWithModelFallback({
    ...fallbackOptions,
    fallbacksOverride: ["fixture-primary/fixture-model"],
    run,
    classifyResult: () => ({ stopReason: "agent_run_terminal_timeout" }),
  });
  expect(run).toHaveBeenCalledOnce();
  expect(result.result?.meta.agentMeta).toMatchObject({
    provider: "runtime-provider",
    model: "runtime-model",
  });
  await capture.flush();
  expect(fallbackRecords()).toHaveLength(0);
});

it.each(stopCases)(
  "records $reason once without replacing or retrying the failure",
  async (row) => {
    const { error, abortSignal } = await row.make();
    Object.freeze(error);
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("must not run");
    const onError = vi.fn();
    const onFallbackStep = vi.fn<ModelFallbackStepHandler>();
    const result = row.image
      ? runWithImageModelFallback({
          cfg: { agents: { defaults: { imageModel } } },
          run,
          onError,
        })
      : runWithModelFallback({ ...fallbackOptions, run, onError, onFallbackStep, abortSignal });
    await expect(result).rejects.toBe(error);
    expect(run).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onFallbackStep).not.toHaveBeenCalled();
    await capture.flush();
    const records = fallbackRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes).toMatchObject({
      event: "model_fallback_chain_stopped",
      reason: row.reason,
      candidateProvider: "fixture-primary",
      candidateModel: "fixture-model",
      ...(error instanceof Error ? { errorName: error.name } : {}),
      ...(row.image ? {} : { sessionId: "chain-stop-session", lane: "chain-stop-lane" }),
    });
    expect(records[0]?.attributes).not.toHaveProperty("decision");
    expect(records[0]?.attributes).not.toHaveProperty("fallbackStepType");
    if (!(error instanceof Error)) {
      expect(records[0]?.attributes).not.toHaveProperty("errorName");
    }
    expect(JSON.stringify(records)).not.toContain(error.message);
  },
);

it.each([
  {
    name: "cannot be read",
    read() {
      throw new Error("error name is unavailable");
    },
  },
  { name: "is not a string", read: () => Symbol("unusable error name") },
])("preserves a terminal timeout when its error name $name", async ({ read }) => {
  const error = terminalTimeout();
  Object.defineProperty(error, "name", { get: read });
  const run = vi.fn().mockRejectedValue(error);
  const failure = await runWithModelFallback({ ...fallbackOptions, run }).catch(
    (caught: unknown) => caught,
  );
  expect(failure === error).toBe(true);
  expect(run).toHaveBeenCalledOnce();
  await capture.flush();
  expect(fallbackRecords()).toHaveLength(1);
  expect(fallbackRecords()[0]?.attributes).toMatchObject({
    event: "model_fallback_chain_stopped",
    reason: "agent_run_terminal_timeout",
  });
  expect(fallbackRecords()[0]?.attributes).not.toHaveProperty("errorName");
});

it("sanitizes compact stop diagnostics without exposing error details", async () => {
  const provider = "fixture\nprovider\u001b[31m";
  const model = "fixture\rmodel\u007f";
  const error = new Error("private diagnostic message", { cause: new Error("private cause") });
  error.name = "Fault\nName\u001b[0m";
  await expect(
    runFallbackAttempt({
      run: async () => {
        throw error;
      },
      provider,
      model,
      attempts: [],
      attempt: 1,
      total: 2,
      abortSignal: AbortSignal.abort(),
    }),
  ).rejects.toBe(error);
  await capture.flush();
  expect(fallbackRecords()).toHaveLength(1);
  expect(fallbackRecords()[0]?.attributes).toMatchObject({
    candidateProvider: provider,
    candidateModel: model,
    errorName: error.name,
  });
  expect(fallbackRecords()[0]?.attributes).not.toHaveProperty("sessionId");
  expect(fallbackRecords()[0]?.attributes).not.toHaveProperty("lane");
  expect(warn).toHaveBeenCalledOnce();
  const line = String(warn.mock.calls[0]?.[0]);
  expect(line).toContain("candidate=fixtureprovider/fixturemodel errorName=FaultName");
  expect(line).not.toContain("\n");
  expect(line).not.toContain("\r");
  expect(line).not.toContain(error.message);
  expect(line).not.toContain("private cause");
  expect(JSON.stringify(fallbackRecords())).not.toContain("private diagnostic message");
});
