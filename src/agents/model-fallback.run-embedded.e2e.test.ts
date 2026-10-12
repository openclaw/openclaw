// Exercises model fallback through the embedded runner integration surface.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import type { ModelFallbackAvailability } from "./agent-scope.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import { markFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import type { ModelFallbackStepFields } from "./model-fallback-observation.js";
import { createModelFallbackAttemptMocks } from "./model-fallback.run-embedded.attempts.test-support.js";
import {
  CLOUDFLARE_502_ERROR_PAYLOAD,
  type EmbeddedAttemptParams,
  LONG_RATE_LIMIT_ERROR_MESSAGE,
  makeModelFallbackConfig,
  NO_ENDPOINTS_FOUND_ERROR_MESSAGE,
  NO_ERROR_DETAILS_MESSAGE,
  OVERLOADED_ERROR_PAYLOAD,
  RATE_LIMIT_ERROR_MESSAGE,
  readFallbackUsageStats,
  REAL_TRANSPORT_PER_DAY_CAP_ERROR_MESSAGE,
  withModelFallbackWorkspace,
  writeFallbackAuthStore,
  writeFallbackMultiProfileAuthStore,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const observedModelRoutingProvenance: Array<{
  stage: "initial" | "fallback";
  fallbackReason?: string;
}> = [];
const suspendSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
}));

const installRunEmbeddedMocks = () => {
  // Install the runner mocks before importing runEmbeddedAgent so the e2e path
  // exercises fallback orchestration without live model/provider calls.
  vi.doMock("../plugins/runtime.js", () => ({
    getActivePluginRegistry: () => null,
    getActivePluginRegistryWorkspaceDir: () => undefined,
    requireActivePluginRegistry: () => ({}),
  }));
  vi.doMock("./harness/runtime-plugin.js", () => ({
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
  }));
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
  });
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
  });
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  vi.doMock("./session-suspension.js", async () => {
    const actual =
      await vi.importActual<typeof import("./session-suspension.js")>("./session-suspension.js");
    return { ...actual, suspendSession: suspendSessionMock };
  });
};

type ProductionRunEmbeddedAgent = typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
type TestRunEmbeddedAgent = (
  params: Omit<Parameters<ProductionRunEmbeddedAgent>[0], "admittedRunContext">,
) => ReturnType<ProductionRunEmbeddedAgent>;
let runEmbeddedAgent: TestRunEmbeddedAgent;
let runEmbeddedAgentWithPreparedAdmission: ProductionRunEmbeddedAgent;
let runWithModelFallback: typeof import("./model-fallback-runner.js").runWithModelFallback;
let runEmbeddedAgentEntry: typeof import("./embedded-agent-runner/run-entry.js").runEmbeddedAgentEntry;
let captureRoutingDecisionWork: typeof import("./test-helpers/model-routing-decision-e2e-fixtures.js").captureRoutingDecisionWork;
let createModelRoutingTestAdmission: typeof import("./test-helpers/model-routing-decision-e2e-fixtures.js").createModelRoutingTestAdmission;

beforeAll(async () => {
  installRunEmbeddedMocks();
  runEmbeddedAgentWithPreparedAdmission = (await import("./embedded-agent-runner/run.js"))
    .runEmbeddedAgent;
  runEmbeddedAgent = wrapRunWithTestPreparedAdmission(runEmbeddedAgentWithPreparedAdmission);
  ({ runWithModelFallback } = await import("./model-fallback-runner.js"));
  ({ runEmbeddedAgentEntry } = await import("./embedded-agent-runner/run-entry.js"));
  ({ captureRoutingDecisionWork, createModelRoutingTestAdmission } =
    await import("./test-helpers/model-routing-decision-e2e-fixtures.js"));
});

beforeEach(() => {
  resetFallbackSkipCacheForTest();
  observedModelRoutingProvenance.length = 0;
  runEmbeddedAttemptMock.mockReset();
  suspendSessionMock.mockClear();
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

async function runEmbeddedFallback(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  provider?: string;
  sessionId?: string;
  lane?: string;
  abortSignal?: AbortSignal;
  config?: OpenClawConfig;
}) {
  // Runs the same embedded-agent entrypoint that production fallback uses while
  // keeping provider/model attempts deterministic through mocks.
  const cfg = params.config ?? makeModelFallbackConfig();
  const sessionId = params.sessionId ?? `session:${params.runId}`;
  return await runWithModelFallback({
    cfg,
    provider: params.provider ?? "openai",
    model: "mock-1",
    runId: params.runId,
    sessionId: params.sessionId,
    lane: params.lane,
    agentDir: params.agentDir,
    abortSignal: params.abortSignal,
    run: (provider, model, options) =>
      runEmbeddedAgent({
        sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: cfg,
        prompt: "hello",
        provider,
        model,
        lane: params.lane,
        authProfileIdSource: "auto",
        allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
        isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
        timeoutMs: 5_000,
        runId: params.runId,
        abortSignal: params.abortSignal,
        enqueue: async (task) => await task(),
      }),
  });
}

async function runEmbeddedEntryFallback(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  config?: OpenClawConfig;
  fallbacksOverride?: string[];
  modelFallbackAvailability?: ModelFallbackAvailability;
  onFallbackStep?: (step: ModelFallbackStepFields) => void;
}) {
  const cfg = params.config ?? makeModelFallbackConfig();
  const sessionId = `session:${params.runId}`;
  const preparedRunAdmission = createModelRoutingTestAdmission({
    cfg: { ...cfg, logging: { audit: { executionIdentity: true } } },
    runId: params.runId,
    boundary: "model-fallback-e2e",
  });
  try {
    return await runEmbeddedAgentEntry({
      selection: {
        cfg,
        provider: "openai",
        model: "mock-1",
        agentDir: params.agentDir,
        manifestPlugins: [],
        fallbacksOverride: params.fallbacksOverride,
      },
      identity: {
        runId: params.runId,
        agentId: "test",
        sessionId,
        sessionKey: params.sessionKey,
      },
      harness: {
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
        resolveContextEngineHost: (provider, model) => ({
          id: `embedded-e2e:${provider}/${model}`,
          label: "embedded runner e2e",
          capabilities: [],
        }),
      },
      behavior: { kind: "maintenance" },
      sessionOverride: { kind: "preserve" },
      onFallbackStep: params.onFallbackStep,
      runCandidate: (provider, model, options) => {
        observedModelRoutingProvenance.push(options.modelRoutingProvenance);
        return runEmbeddedAgentWithPreparedAdmission({
          preparedRunAdmission,
          sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          config: cfg,
          ...(params.modelFallbackAvailability
            ? { modelFallbackAvailability: params.modelFallbackAvailability }
            : {}),
          prompt: "hello",
          provider,
          model,
          modelRoutingProvenance: options.modelRoutingProvenance,
          authProfileIdSource: "auto",
          isFinalFallbackAttempt: options.isFinalFallbackAttempt,
          timeoutMs: 5_000,
          runId: params.runId,
          enqueue: async (task) => await task(),
          contextEngineLogicalTurnLease: options.contextEngineLogicalTurnLease,
          onContextEngineTurnCandidate: options.onContextEngineTurnCandidate,
        });
      },
    });
  } finally {
    preparedRunAdmission.close();
  }
}

const {
  mockPrimaryOverloadedThenFallbackSuccess,
  mockPrimaryFailureThenFallbackSuccess,
  mockPrimaryPromptErrorThenFallbackSuccess,
  mockPrimarySuspendingPromptErrorThenFallbackSuccess,
  mockPrimaryErrorThenFallbackSuccess,
  mockPrimaryStaleRateLimitTextSuccess,
} = createModelFallbackAttemptMocks(runEmbeddedAttemptMock);

function expectAttemptOrder(expected: Array<{ provider: string; authProfileId: string }>) {
  expect(
    runEmbeddedAttemptMock.mock.calls.map(([params]) => {
      const attempt = params as EmbeddedAttemptParams;
      return { provider: attempt.provider, authProfileId: attempt.authProfileId };
    }),
  ).toEqual(expected);
}

function expectOpenAiThenGroqAttemptOrder(params?: { primaryAttempts?: number }) {
  expectAttemptOrder([
    ...Array.from({ length: params?.primaryAttempts ?? 1 }, () => ({
      provider: "openai",
      authProfileId: "openai:p1",
    })),
    { provider: "groq", authProfileId: "groq:p1" },
  ]);
}

function mockAllProvidersOverloaded() {
  runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
    const attemptParams = params as { provider: string; modelId: string; authProfileId?: string };
    if (attemptParams.provider === "openai" || attemptParams.provider === "groq") {
      return makeEmbeddedRunnerAttempt({
        providerRetryMaxRetries: 3,
        assistantTexts: [],
        lastAssistant: buildEmbeddedRunnerAssistant({
          provider: attemptParams.provider,
          model: attemptParams.provider === "openai" ? "mock-1" : "mock-2",
          stopReason: "error",
          errorMessage: OVERLOADED_ERROR_PAYLOAD,
        }),
      });
    }
    throw new Error(`Unexpected provider ${attemptParams.provider}`);
  });
}

function countProviderAttempts(provider: string) {
  return runEmbeddedAttemptMock.mock.calls.filter(
    (call) => (call[0] as { provider?: string })?.provider === provider,
  ).length;
}

function expectProviderAttemptCounts(expected: { openai: number; groq: number }) {
  expect(countProviderAttempts("openai")).toBe(expected.openai);
  expect(countProviderAttempts("groq")).toBe(expected.groq);
}

describe("runWithModelFallback + runEmbeddedAgent failover behavior", () => {
  it.each([
    { name: "prompt failure", phase: "prompt", fallback: true, promptFailure: true },
    { name: "aborted assistant", phase: "prompt", fallback: true },
    { name: "compaction", phase: "compaction", fallback: false },
    { name: "tool execution", phase: "tool_execution", fallback: false },
    { name: "external timeout", phase: "prompt", fallback: false, external: true },
    { name: "committed tool effects", phase: "prompt", fallback: false, wrote: true },
    { name: "invalid replay", phase: "prompt", fallback: false, replayInvalid: true },
  ] as const)("preserves attempt timeout fallback eligibility after $name", async (scenario) => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      const promptFailure = "promptFailure" in scenario;
      mockPrimaryFailureThenFallbackSuccess(() =>
        makeEmbeddedRunnerAttempt({
          terminal: {
            kind: "timeout",
            phase: scenario.phase,
            source: "external" in scenario ? "external" : "run_budget",
            aborted: true,
            ...(promptFailure
              ? { failure: { source: "prompt", error: new Error("attempt deadline reached") } }
              : {}),
          },
          lastAssistant: promptFailure
            ? undefined
            : buildEmbeddedRunnerAssistant({
                provider: "openai",
                model: "mock-1",
                stopReason: "aborted",
                content: [],
              }),
          toolMetas: "wrote" in scenario ? [{ toolName: "write", replaySafe: false }] : [],
          ...("replayInvalid" in scenario ? { promptTimeoutOutcome: { replayInvalid: true } } : {}),
        }),
      );
      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:attempt-timeout",
        runId: "run:attempt-timeout",
      });

      expectProviderAttemptCounts({ openai: 1, groq: scenario.fallback ? 1 : 0 });
      if (scenario.fallback) {
        expect(result.result.payloads?.[0]?.text).toBe("fallback ok");
        expect(result.result.meta.error).toBeUndefined();
        expect(
          runEmbeddedAttemptMock.mock.calls.map(
            ([params]) => (params as { timeoutMs: number }).timeoutMs,
          ),
        ).toEqual([5_000, 5_000]);
      }
    });
  });

  it.each(["thrown", "assistant"] as const)(
    "does not replay %s transcript turn assertions through retries or model fallback",
    async (surface) => {
      await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
        await writeFallbackAuthStore(agentDir);
        const errorMessage = "Session transcript keyed user is outside the current turn: old-input";
        runEmbeddedAttemptMock.mockImplementation(async (params) => {
          if (surface === "thrown") {
            throw new Error(errorMessage);
          }
          const attempt = params as EmbeddedAttemptParams;
          return makeEmbeddedRunnerAttempt({
            lastAssistant: buildEmbeddedRunnerAssistant({
              provider: attempt.provider,
              model: attempt.modelId,
              stopReason: "error",
              errorMessage,
            }),
          });
        });
        const result = await runEmbeddedEntryFallback({
          agentDir,
          workspaceDir,
          sessionKey: "agent:test:transcript-assertion",
          runId: "announce:requester-settle:test:transcript-assertion",
          fallbacksOverride: ["groq/mock-2", "groq/mock-3"],
        }).catch((error: unknown) => error);

        expect(runEmbeddedAttemptMock).toHaveBeenCalledOnce();
        expect(result).toBeInstanceOf(Error);
        expect(result).toMatchObject({ message: errorMessage });
        expect(suspendSessionMock).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps a pinned model on its rate-limit surface instead of escalating to fallback", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackMultiProfileAuthStore(agentDir);
      // Same rate-limit rotation-cap scenario as #58572, but the session pins
      // the model (empty effective ladder + disabled availability). Pre-fix the
      // run derived fallbackConfigured from config defaults, so the rotation
      // cap escalated to fallback_model over the empty ladder and threw the
      // escalation error ("temporarily rate-limited") before spending the
      // same-model retry budget.
      mockPrimaryErrorThenFallbackSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const fallbackSteps: ModelFallbackStepFields[] = [];
      const run = runEmbeddedEntryFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:user-model-override-rate-limit",
        runId: "run:user-model-override-rate-limit",
        fallbacksOverride: [],
        // Prepared by the session model selection path for
        // hasSessionModelOverride=true and modelOverrideSource="user".
        modelFallbackAvailability: { kind: "disabled_by_model_override" },
        onFallbackStep: (step) => fallbackSteps.push(step),
      });

      await expect(run).rejects.toMatchObject({
        name: "FailoverError",
        message: "⚠️ The AI service needs a short break. Please try again in a few minutes.",
        reason: "rate_limit",
        provider: "openai",
        model: "mock-1",
        suspend: true,
      });
      // Pre-fix the bogus escalation fired after two primary attempts; the
      // truthful no-fallback path spends every rotation and same-model retry.
      expect(runEmbeddedAttemptMock.mock.calls.length).toBeGreaterThan(2);
      expect(
        runEmbeddedAttemptMock.mock.calls.every(
          ([params]) => (params as EmbeddedAttemptParams).provider === "openai",
        ),
      ).toBe(true);
      // The exhausted-chain observation records no switch to another model.
      expect(fallbackSteps.map((step) => step.fallbackStepFinalOutcome)).toEqual([
        "chain_exhausted",
      ]);
      expect(fallbackSteps[0]?.fallbackStepToModel).toBeUndefined();
    });
  });

  it("keeps fallback enabled for auto-selected routes and traces the winning execution", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();
      const { decisionWork, result } = await captureRoutingDecisionWork(() =>
        runEmbeddedEntryFallback({
          agentDir,
          workspaceDir,
          sessionKey: "agent:test:execution-trace-fallback",
          runId: "run:execution-trace-fallback",
          fallbacksOverride: ["groq/mock-2"],
          modelFallbackAvailability: {
            kind: "active",
            models: ["groq/mock-2"],
            source: "explicit",
          },
        }),
      );

      expect(result.result.payloads?.[0]?.text).toContain("fallback ok");
      expect(result.result.meta.error).toBeUndefined();
      expect(
        runEmbeddedAttemptMock.mock.calls.map(
          ([params]) => (params as EmbeddedAttemptParams).provider,
        ),
      ).toContain("groq");
      expect(result.result.meta.executionTrace).toMatchObject({
        winnerProvider: "groq",
        winnerModel: "mock-2",
        fallbackUsed: true,
        runner: "embedded",
      });
      expect(result.result.meta.executionTrace?.attempts).toEqual([
        expect.objectContaining({
          provider: "openai",
          model: "mock-1",
          result: "candidate_failed",
          reason: "overloaded",
        }),
        expect.objectContaining({
          provider: "groq",
          model: "mock-2",
          result: "success",
        }),
      ]);
      expect(result.result.meta.agentMeta?.terminalReceipt).toMatchObject({
        requested: { provider: "openai", model: "mock-1" },
        effective: { provider: "groq", model: "mock-2" },
        rerouted: true,
      });
      expect(result.terminal.metadata.terminalReceipt).toMatchObject({
        requested: { provider: "openai", model: "mock-1" },
        effective: { provider: "groq", model: "mock-2" },
        rerouted: true,
      });
      expect(decisionWork).toHaveLength(5);
      expect(decisionWork.map((work) => work.receipt)).toMatchObject([
        ...Array.from({ length: 4 }, () => ({
          action: { summary: "Requested openai/mock-1; selected openai/mock-1." },
          decision: { reasonCode: "model_route_selected" },
        })),
        {
          action: { summary: "Requested openai/mock-1; selected groq/mock-2." },
          decision: { reasonCode: "overloaded" },
        },
      ]);
      expect(observedModelRoutingProvenance).toMatchObject([
        { stage: "initial" },
        { stage: "fallback", fallbackReason: "overloaded" },
      ]);
    });
  });

  it("does not record a receipt for a skipped fallback candidate", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      const runId = "run:execution-trace-skipped-fallback";
      await writeFallbackAuthStore(agentDir);
      mockAllProvidersOverloaded();
      markFallbackCandidateSkipped({
        sessionId: `session:${runId}`,
        provider: "groq",
        model: "mock-2",
        authScope: "groq:p1",
        reason: "auth",
        ttlMs: 60_000,
      });

      const { decisionWork } = await captureRoutingDecisionWork(async () => {
        await expect(
          runEmbeddedEntryFallback({
            agentDir,
            workspaceDir,
            sessionKey: "agent:test:execution-trace-skipped-fallback",
            runId,
          }),
        ).rejects.toThrow("All models failed");
        expectAttemptOrder(
          Array.from({ length: 4 }, () => ({ provider: "openai", authProfileId: "openai:p1" })),
        );
      });
      expect(
        decisionWork.map((work) => ({
          target: work.refs?.target?.value,
          reason: work.receipt.decision.reasonCode,
        })),
      ).toEqual(
        Array.from({ length: 4 }, () => ({
          target: JSON.stringify(["openai", "mock-1"]),
          reason: "model_route_selected",
        })),
      );
    });
  });

  it("keeps tool summary on incomplete side-effect terminal results", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeEmbeddedRunnerAttempt({
          toolMetas: [{ toolName: "write", meta: "path=out.txt" }],
          lastAssistant: buildEmbeddedRunnerAssistant({
            provider: "openai",
            model: "mock-1",
            stopReason: "stop",
            content: [],
          }),
        }),
      );

      const result = await runEmbeddedAgent({
        sessionId: "session:tool-side-effect-terminal",
        sessionKey: "agent:test:tool-side-effect-terminal",
        workspaceDir,
        agentDir,
        config: makeModelFallbackConfig(),
        prompt: "write the file",
        provider: "openai",
        model: "mock-1",
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:tool-side-effect-terminal",
        enqueue: async (task) => await task(),
      });

      expect(result.meta.toolSummary?.calls).toBe(1);
      expect(result.meta.toolSummary?.tools).toEqual(["write"]);
      expect(
        classifyEmbeddedAgentRunResultForModelFallback({
          provider: "openai",
          model: "gpt-5.4",
          result,
        }),
      ).toBeNull();
    });
  });

  const assistantFailures: Array<{
    name: string;
    messages: string[];
    reason: string;
    primaryAttempts?: number;
    provider?: string;
    health?: "missing" | "fallback" | "server" | "timeout" | "overloaded";
    sleeps?: number;
  }> = [
    {
      name: "OpenRouter no-endpoints",
      messages: [NO_ENDPOINTS_FOUND_ERROR_MESSAGE],
      reason: "model_not_found",
      primaryAttempts: 1,
    },
    {
      name: "defaults-only timeout",
      messages: ["LLM request timed out."],
      reason: "timeout",
      primaryAttempts: 4,
    },
    {
      name: "bare leading 402 quota refresh",
      messages: [
        "402 You have reached your subscription quota limit. Please wait for automatic quota refresh in the rolling time window, upgrade to a higher plan, or use a Pay-As-You-Go API Key for unlimited access.",
      ],
      reason: "rate_limit",
      primaryAttempts: 1,
    },
    {
      name: "Azure Foundry missing error details",
      messages: [NO_ERROR_DETAILS_MESSAGE],
      reason: "no_error_details",
      provider: "azure-foundry",
      health: "missing",
      sleeps: 0,
    },
    {
      name: "real-transport per-day cap (#147546)",
      messages: [REAL_TRANSPORT_PER_DAY_CAP_ERROR_MESSAGE],
      reason: "rate_limit",
      primaryAttempts: 1,
      health: "fallback",
      sleeps: 0,
    },
    {
      name: "untyped HTTP 502",
      messages: [CLOUDFLARE_502_ERROR_PAYLOAD],
      reason: "server_error",
      primaryAttempts: 4,
      health: "server",
    },
    {
      name: "provider transport failures",
      messages: ["terminated", "stream_read_error", "Request failed"],
      reason: "timeout",
      primaryAttempts: 4,
      health: "timeout",
      sleeps: 3,
    },
    {
      name: "bare service unavailable",
      messages: ["LLM error: service unavailable"],
      reason: "overloaded",
      primaryAttempts: 4,
      health: "overloaded",
      sleeps: 3,
    },
  ];
  it.each(assistantFailures)(
    "falls back after $name with the correct retry and profile-health policy",
    async ({ name, messages, reason, primaryAttempts, provider = "openai", health, sleeps }) => {
      for (const [index, message] of messages.entries()) {
        const runName = `${name.replaceAll(/[^a-z0-9]+/gi, "-")}:${index}`;
        await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
          await writeFallbackAuthStore(agentDir, undefined, { primaryProvider: provider });
          runEmbeddedAttemptMock.mockClear();
          computeBackoffMock.mockClear();
          sleepWithAbortMock.mockClear();
          mockPrimaryErrorThenFallbackSuccess(message, { primaryProvider: provider });

          const result = await runEmbeddedFallback({
            agentDir,
            workspaceDir,
            sessionKey: `agent:test:${runName}`,
            runId: `run:${runName}`,
            ...(provider === "openai"
              ? {}
              : { provider, config: makeModelFallbackConfig(provider) }),
          });

          expect(result.provider).toBe("groq");
          expect(result.model).toBe("mock-2");
          expect(result.attempts[0]?.reason).toBe(reason);
          expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");
          if (primaryAttempts !== undefined) {
            expectOpenAiThenGroqAttemptOrder({ primaryAttempts });
          } else {
            expect(countProviderAttempts(provider)).toBeGreaterThan(0);
            expect(countProviderAttempts("openai")).toBe(0);
            expect(countProviderAttempts("groq")).toBe(1);
          }
          if (health) {
            const usageStats = await readFallbackUsageStats(agentDir);
            const primaryHealth = usageStats[`${provider}:p1`];
            if (health === "timeout") {
              expect(primaryHealth?.cooldownUntil).toEqual(expect.any(Number));
              expect(primaryHealth?.failureCounts).toEqual({ timeout: 1 });
            } else if (health !== "fallback") {
              expect(primaryHealth?.cooldownUntil).toBeUndefined();
              if (health === "missing") {
                expect(primaryHealth?.failureCounts?.no_error_details).toBeUndefined();
              } else if (health === "overloaded") {
                expect(primaryHealth?.failureCounts).toBeUndefined();
              }
            }
            if (health !== "overloaded") {
              expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");
            }
          }
          if (sleeps !== undefined) {
            expect(computeBackoffMock).not.toHaveBeenCalled();
            expect(sleepWithAbortMock).toHaveBeenCalledTimes(sleeps);
          }
        });
      }
    },
  );

  it.each(["direct", "outer-fallback"] as const)(
    "assigns session suspension to the %s run owner",
    async (mode) => {
      await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
        await writeFallbackAuthStore(agentDir);
        const sessionId = `session:${mode}-suspension`;
        mockPrimarySuspendingPromptErrorThenFallbackSuccess(sessionId);
        const params = {
          agentDir,
          workspaceDir,
          sessionId,
          sessionKey: `agent:test:${mode}-suspension`,
          lane: `${mode}-lane`,
          runId: `run:${mode}-suspension`,
          config: makeModelFallbackConfig(),
        };
        if (mode === "direct") {
          await expect(
            runEmbeddedAgent({
              ...params,
              prompt: "hello",
              provider: "openai",
              model: "mock-1",
              authProfileIdSource: "auto",
              timeoutMs: 5_000,
              enqueue: async (task) => await task(),
            }),
          ).rejects.toThrow();
          expect(suspendSessionMock).toHaveBeenCalledOnce();
          expect(suspendSessionMock.mock.calls[0]?.[0]).not.toHaveProperty("laneId");
        } else {
          const result = await runEmbeddedFallback(params);
          expect(result.provider).toBe("groq");
          expect(suspendSessionMock).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("surfaces a bounded overloaded summary when every fallback candidate is overloaded", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockAllProvidersOverloaded();

      let thrown: unknown;
      try {
        await runEmbeddedFallback({
          agentDir,
          workspaceDir,
          sessionKey: "agent:test:all-overloaded",
          runId: "run:all-overloaded",
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/^All models failed \(2\): /);
      expect((thrown as Error).message).toMatch(
        /openai\/mock-1: .* \(overloaded\) \| groq\/mock-2: .* \(overloaded\)/,
      );

      expectAttemptOrder([
        ...Array.from({ length: 4 }, () => ({ provider: "openai", authProfileId: "openai:p1" })),
        ...Array.from({ length: 4 }, () => ({ provider: "groq", authProfileId: "groq:p1" })),
      ]);
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).toHaveBeenCalledTimes(6);
    });
  });

  it("probes a provider already in overloaded cooldown before falling back", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      const now = Date.now();
      await writeFallbackAuthStore(agentDir, {
        "openai:p1": {
          lastUsed: 1,
          cooldownUntil: now + 60_000,
          failureCounts: { overloaded: 2 },
        },
        "groq:p1": { lastUsed: 2 },
      });
      mockPrimaryOverloadedThenFallbackSuccess();

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-probe-fallback",
        runId: "run:overloaded-probe-fallback",
      });

      expect(result.provider).toBe("groq");
      expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });
    });
  });

  it("keeps overloaded failures provider-scoped across turns while continuing fallback", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();

      const firstResult = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-two-turns:first",
        runId: "run:overloaded-two-turns:first",
      });

      expect(firstResult.provider).toBe("groq");
      expect(firstResult.model).toBe("mock-2");
      expect(firstResult.attempts[0]?.reason).toBe("overloaded");
      expect(firstResult.result.payloads?.[0]?.text ?? "").toContain("fallback ok");
      const firstUsageStats = await readFallbackUsageStats(agentDir);
      expect(firstUsageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
      expect(firstUsageStats["openai:p1"]?.failureCounts?.overloaded).toBeUndefined();
      expect(typeof firstUsageStats["groq:p1"]?.lastUsed).toBe("number");
      expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);

      runEmbeddedAttemptMock.mockClear();
      computeBackoffMock.mockClear();
      sleepWithAbortMock.mockClear();

      mockPrimaryOverloadedThenFallbackSuccess();

      const secondResult = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-two-turns:second",
        runId: "run:overloaded-two-turns:second",
      });

      expect(secondResult.provider).toBe("groq");
      expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });

      const usageStats = await readFallbackUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
      expect(usageStats["openai:p1"]?.failureCounts?.overloaded).toBeUndefined();
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
    });
  });

  it.each([
    {
      name: "untyped HTTP 502",
      source: "assistant",
      message: CLOUDFLARE_502_ERROR_PAYLOAD,
      reason: "server_error",
      profiles: 2,
      primaryAttempts: 4,
    },
    {
      name: "overloaded (#58348)",
      source: "assistant",
      message: OVERLOADED_ERROR_PAYLOAD,
      reason: "overloaded",
      profiles: 3,
      primaryAttempts: 4,
    },
    {
      name: "long-window assistant rate limit (#58572)",
      source: "assistant",
      message: LONG_RATE_LIMIT_ERROR_MESSAGE,
      reason: "rate_limit",
      profiles: 3,
      primaryAttempts: 1,
    },
    {
      name: "long-window prompt rate limit",
      source: "prompt",
      message: LONG_RATE_LIMIT_ERROR_MESSAGE,
      reason: "rate_limit",
      profiles: 3,
      primaryAttempts: 1,
    },
    {
      name: "structured prompt rate limit",
      source: "structured",
      message: "You've reached your Codex subscription usage limit.",
      reason: "rate_limit",
      profiles: 2,
      primaryAttempts: 1,
    },
  ] as const)(
    "bounds profile rotation before falling back after $name",
    async ({ source, message, reason, profiles, primaryAttempts }) => {
      await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
        await writeFallbackMultiProfileAuthStore(agentDir, { openAiProfileCount: profiles });
        if (source === "assistant") {
          mockPrimaryErrorThenFallbackSuccess(message);
        } else if (source === "prompt") {
          mockPrimaryPromptErrorThenFallbackSuccess(message);
        } else {
          mockPrimaryFailureThenFallbackSuccess(() =>
            makeEmbeddedRunnerAttempt({
              terminal: {
                kind: "failed",
                source: "prompt",
                error: Object.assign(new Error(message), { status: 429 as const }),
              },
            }),
          );
        }

        const result = await runEmbeddedFallback({
          agentDir,
          workspaceDir,
          sessionKey: `agent:test:rotation:${source}:${reason}`,
          runId: `run:rotation:${source}:${reason}`,
        });

        expect(result.provider).toBe("groq");
        expect(result.model).toBe("mock-2");
        expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");
        expectAttemptOrder([
          ...Array.from({ length: primaryAttempts }, () => ({
            provider: "openai",
            authProfileId: "openai:p1",
          })),
          { provider: "openai", authProfileId: "openai:p2" },
          { provider: "groq", authProfileId: "groq:p1" },
        ]);
        if (reason === "server_error") {
          const usageStats = await readFallbackUsageStats(agentDir);
          expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
          expect(usageStats["openai:p2"]?.cooldownUntil).toBeUndefined();
        } else if (reason === "overloaded") {
          expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
        } else {
          expectProviderAttemptCounts({ openai: 2, groq: 1 });
          if (source === "structured") {
            expect(result.attempts[0]?.reason).toBe("rate_limit");
            const primaryCalls = runEmbeddedAttemptMock.mock.calls
              .map(([params]) => params as EmbeddedAttemptParams)
              .filter((params) => params.provider === "openai");
            expect(primaryCalls.map((params) => params.authProfileId)).toStrictEqual([
              "openai:p1",
              "openai:p2",
            ]);
            expect(primaryCalls.map((params) => params.modelId)).toStrictEqual([
              "mock-1",
              "mock-1",
            ]);
          }
        }
      });
    },
  );

  it("ignores stale classified rate-limit text when stopReason is not error", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackMultiProfileAuthStore(agentDir);

      mockPrimaryStaleRateLimitTextSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:rate-limit-retry-limit-fallback",
        runId: "run:rate-limit-retry-limit-fallback",
        config: {
          ...makeModelFallbackConfig(),
        },
      });

      expect(result.provider).toBe("openai");
      expect(result.model).toBe("mock-1");
      expect(result.attempts).toEqual([]);

      expectProviderAttemptCounts({ openai: 1, groq: 0 });
    });
  });
});
