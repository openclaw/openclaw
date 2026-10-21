import { afterAll, afterEach, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { testApi as loggerTestApi } from "../logging/logger.test-support.js";
import { loggingState } from "../logging/state.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { CommandLaneTaskTimeoutError } from "../process/command-queue.js";
import { AgentRunTerminalOutcomeError } from "./agent-run-terminal-error.js";
import { abortable } from "./embedded-agent-runner/run/abortable.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./embedded-agent-runner/run/terminal-outcome.js";
import { resolveEmbeddedRunTerminalTimeout } from "./embedded-agent-runner/run/terminal-timeout.js";
import { FailoverError } from "./failover-error.js";
import { AgentHarnessPreflightError } from "./harness/errors.js";
import { type ModelFallbackStepHandler, runFallbackAttempt } from "./model-fallback-attempt.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import {
  logModelFallbackDecision,
  type ModelFallbackDecisionParams,
} from "./model-fallback-observation.js";
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
beforeAll(() => logPaths.setup());
afterAll(() => logPaths.cleanup());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-06-16T00:00:00Z") });
  activeSessionId = `session-${++testSequence}`;
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
  vi.useRealTimers();
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
type StopError = Error | { message: string };
const stopCases: Array<
  [
    reason: string,
    make: () => StopError | Promise<StopError>,
    image?: boolean,
    opaqueName?: boolean,
  ]
> = [
  ["agent_run_terminal_timeout", terminalTimeout],
  [
    "command_lane_task_timeout",
    () =>
      new CommandLaneTaskTimeoutError("chain-stop-lane", {
        cause: "release-signal",
        elapsedMs: 0,
        taskBudgetMs: 60_000,
      }),
  ],
  [
    "agent_harness_preflight",
    () => new AgentHarnessPreflightError("private preflight detail"),
    true,
  ],
  [
    "sandbox_provisioning",
    () => toSandboxProvisioningError(new Error("private sandbox detail"), "fixture"),
  ],
  ["caller_signal_aborted", () => ({ message: "private caller detail" })],
  ["agent_run_direct_abort", createAgentRunDirectAbortError],
  ["agent_run_restart_abort", createAgentRunRestartAbortError],
  ["session_placement_settlement_closed", createSessionPlacementSettlementClosedAbortError],
  ["terminal_abort_wrapper", terminalAbortWrapper],
  ...[
    () => {
      throw new Error("error name is unavailable");
    },
    () => Symbol("unusable error name"),
  ].map((get): [string, () => Error, boolean, boolean] => [
    "agent_run_terminal_timeout",
    () => Object.defineProperty(terminalTimeout(), "name", { get }),
    false,
    true,
  ]),
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
        replyDeliveryState: "missing",
        sourceReplyDeliveryState: "missing",
        preparedTerminalReply: { text: "", terminalReply: { disposition: "empty" } },
        reportedModelRef: { provider: "runtime-provider", model: "runtime-model" },
        finalAssistantVisibleText: "",
        finalAssistantRawText: undefined,
        finalAssistantMessageRawText: undefined,
        timedOutDuringPrompt: true,
        recoveredFinalAssistantPayloadsAfterPromptTimeout: undefined,
        hasSuccessfulFinalAssistantAfterPromptTimeout: false,
        hasPartialAssistantTextAfterPromptTimeout: false,
        payloads: [],
        payloadsWithToolMedia: [],
        payloadsForVisibleCompletion: [],
        agentMeta: {
          sessionId: "chain-stop-session",
          provider: "runtime-provider",
          model: "runtime-model",
        },
        attemptToolSummary: undefined,
        failureSignal: undefined,
        terminalToolFailure: undefined,
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
  "records %s once without replacing or retrying the failure (case %#)",
  async (reason, make, image, opaqueName) => {
    const error = await make();
    const abortSignal = reason === "caller_signal_aborted" ? AbortSignal.abort() : undefined;
    Object.freeze(error);
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("must not run");
    const onError = vi.fn();
    const onFallbackStep = vi.fn<ModelFallbackStepHandler>();
    const result = image
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
      reason,
      candidateProvider: "fixture-primary",
      candidateModel: "fixture-model",
      ...(error instanceof Error && !opaqueName ? { errorName: error.name } : {}),
      ...(image ? {} : { sessionId: "chain-stop-session", lane: "chain-stop-lane" }),
    });
    expect(records[0]?.attributes).not.toHaveProperty("decision");
    expect(records[0]?.attributes).not.toHaveProperty("fallbackStepType");
    if (!(error instanceof Error) || opaqueName) {
      expect(records[0]?.attributes).not.toHaveProperty("errorName");
    }
    expect(JSON.stringify(records)).not.toContain(error.message);
  },
);

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

let activeSessionId = "session-0";
let testSequence = 0;
const primary = { provider: "modelstudio", model: "glm-5" };
const fallback = { provider: "minimax", model: "MiniMax-M2.7-highspeed" };

function logFailure(overrides: Partial<ModelFallbackDecisionParams> = {}) {
  return logModelFallbackDecision({
    decision: "candidate_failed",
    runId: "run-1",
    sessionId: activeSessionId,
    requestedProvider: primary.provider,
    requestedModel: primary.model,
    candidate: { ...primary, routeOrigin: "requested", routeResolution: "raw" },
    attempt: 1,
    reason: "auth",
    status: 401,
    code: "invalid_token",
    error: "HTTP 401: invalid access token or token expired",
    nextCandidate: { ...fallback, routeOrigin: "configured-fallback", routeResolution: "resolved" },
    ...overrides,
  });
}

function loggedPayloads() {
  return fallbackRecords().map((record) => record.attributes ?? {});
}

it.each(["candidate_failed", "candidate_succeeded"] as const)(
  "keeps %s error details in the returned step, not routine diagnostics",
  async (decision) => {
    const marker = "synthetic-private-tool-output";
    const step = logFailure({
      decision,
      error: marker,
      previousAttempts: [{ provider: "prior", model: "prior", error: marker, reason: "auth" }],
    });
    expect(step?.fallbackStepFromFailureDetail).toBe(marker);
    await capture.flush();
    expect(fallbackRecords()).not.toHaveLength(0);
    expect(JSON.stringify(fallbackRecords())).not.toContain(marker);
    expect(loggedPayloads()[0]).toMatchObject({ status: 401, code: "invalid_token" });
  },
);

it("coalesces duplicate auth failures while preserving fallback step fields", async () => {
  const firstStep = logFailure({ runId: "run-1" });
  const secondStep = logFailure({ runId: "run-2" });
  const thirdStep = logFailure({ runId: "run-3" });

  expect(firstStep).toMatchObject({
    fallbackStepFromModel: "modelstudio/glm-5",
    fallbackStepToModel: "minimax/MiniMax-M2.7-highspeed",
    fallbackStepFromFailureReason: "auth",
  });
  expect([secondStep, thirdStep]).toEqual([firstStep, firstStep]);
  await capture.flush();
  expect(fallbackRecords()).toHaveLength(1);
  expect(loggedPayloads()[0]).toMatchObject({
    candidateRouteOrigin: "requested",
    candidateRouteResolution: "raw",
    nextCandidateRouteOrigin: "configured-fallback",
    nextCandidateRouteResolution: "resolved",
  });

  vi.setSystemTime(Date.now() + 30_000);
  logFailure({ runId: "run-4" });

  await capture.flush();
  expect(fallbackRecords()).toHaveLength(2);
  expect(loggedPayloads()[1]).toMatchObject({ suppressedDuplicateCount: 2 });
  expect(String(loggedPayloads()[1]?.consoleMessage)).toContain("2 duplicates suppressed");
});

it("keeps no-session runs visible by scoping coalescing to the run id", async () => {
  logFailure({ sessionId: undefined, runId: "run-1" });
  logFailure({ sessionId: undefined, runId: "run-2" });

  await capture.flush();
  expect(fallbackRecords()).toHaveLength(2);
});
