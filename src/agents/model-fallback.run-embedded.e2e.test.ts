import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import type { ModelFallbackAvailability } from "./agent-scope.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { markFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import type { ModelFallbackStepFields } from "./model-fallback-observation.js";
import { createFallbackE2eMocks } from "./model-fallback.e2e.test-support.js";
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
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const observedModelRoutingProvenance: Array<{
  stage: "initial" | "fallback";
  fallbackReason?: string;
}> = [];
const fallbackMocks = createFallbackE2eMocks((params) => runEmbeddedAttemptMock(params));
const { suspendSessionMock, computeBackoffMock, sleepWithAbortMock } = fallbackMocks;
vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
}));

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
  fallbackMocks.install();
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
  fallbackMocks.clear();
});

type Workspace = { agentDir: string; workspaceDir: string };
const enqueue: NonNullable<Parameters<TestRunEmbeddedAgent>[0]["enqueue"]> = async (task) =>
  await task();
function embeddedParams(
  { agentDir, workspaceDir, runId, sessionKey }: Workspace & { runId: string; sessionKey: string },
  config: OpenClawConfig,
  sessionId = `session:${runId}`,
) {
  return {
    agentDir,
    workspaceDir,
    runId,
    sessionKey,
    sessionId,
    config,
    prompt: "hello",
    authProfileIdSource: "auto" as const,
    timeoutMs: 5_000,
    enqueue,
  };
}
async function runEmbeddedFallback(
  workspace: Workspace,
  name: string,
  overrides: {
    provider?: string;
    sessionId?: string;
    lane?: string;
    abortSignal?: AbortSignal;
    config?: OpenClawConfig;
  } = {},
) {
  const params = {
    ...workspace,
    sessionKey: `agent:test:${name}`,
    runId: `run:${name}`,
    ...overrides,
  };
  const cfg = params.config ?? makeModelFallbackConfig();
  setRuntimeConfigSnapshot(cfg, cfg);
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
        ...embeddedParams(params, cfg, sessionId),
        provider,
        model,
        lane: params.lane,
        allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
        isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
        abortSignal: params.abortSignal,
      }),
  });
}

async function runEmbeddedEntryFallback(
  workspace: Workspace,
  name: string,
  options: {
    runId?: string;
    config?: OpenClawConfig;
    fallbacksOverride?: string[];
    modelFallbackAvailability?: ModelFallbackAvailability;
    onFallbackStep?: (step: ModelFallbackStepFields) => void;
  } = {},
) {
  const { agentDir, workspaceDir } = workspace;
  const { fallbacksOverride, modelFallbackAvailability, onFallbackStep } = options;
  const runId = options.runId ?? `run:${name}`;
  const sessionKey = `agent:test:${name}`;
  const cfg = options.config ?? makeModelFallbackConfig();
  setRuntimeConfigSnapshot(cfg, cfg);
  const sessionId = `session:${runId}`;
  const preparedRunAdmission = createModelRoutingTestAdmission({
    cfg: { ...cfg, logging: { audit: { executionIdentity: true } } },
    runId,
    boundary: "model-fallback-e2e",
  });
  try {
    return await runEmbeddedAgentEntry({
      selection: {
        cfg,
        provider: "openai",
        model: "mock-1",
        agentDir,
        manifestPlugins: [],
        fallbacksOverride,
      },
      identity: {
        runId,
        agentId: "test",
        sessionId,
        sessionKey,
      },
      harness: {
        workspaceDir,
        sessionKey,
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
      onFallbackStep,
      runCandidate: (provider, model, attemptOptions) => {
        observedModelRoutingProvenance.push(attemptOptions.modelRoutingProvenance);
        return runEmbeddedAgentWithPreparedAdmission({
          ...embeddedParams({ ...workspace, runId, sessionKey }, cfg, sessionId),
          preparedRunAdmission,
          ...(modelFallbackAvailability ? { modelFallbackAvailability } : {}),
          provider,
          model,
          modelRoutingProvenance: attemptOptions.modelRoutingProvenance,
          isFinalFallbackAttempt: attemptOptions.isFinalFallbackAttempt,
          contextEngineLogicalTurnLease: attemptOptions.contextEngineLogicalTurnLease,
          onContextEngineTurnCandidate: attemptOptions.onContextEngineTurnCandidate,
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
    recordedAttempts().map(({ provider, authProfileId }) => ({ provider, authProfileId })),
  ).toEqual(expected);
}

function profileAttempts(provider: string, count = 1, profile = 1) {
  return Array.from({ length: count }, () => ({
    provider,
    authProfileId: `${provider}:p${profile}`,
  }));
}

function expectNoBackoffWithSleeps(count: number) {
  expect(computeBackoffMock).not.toHaveBeenCalled();
  expect(sleepWithAbortMock).toHaveBeenCalledTimes(count);
}

function expectFallbackSuccess(result: Awaited<ReturnType<typeof runEmbeddedFallback>>) {
  expect(result).toMatchObject({ provider: "groq", model: "mock-2" });
  expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");
}

function recordedAttempts() {
  return runEmbeddedAttemptMock.mock.calls.map(([params]) => params as EmbeddedRunAttemptParams);
}

function expectOpenAiThenGroqAttemptOrder(params?: { primaryAttempts?: number }) {
  expectAttemptOrder([
    ...profileAttempts("openai", params?.primaryAttempts ?? 1),
    ...profileAttempts("groq"),
  ]);
}

async function withDefaultAuth(fn: (workspace: Workspace) => Promise<void>) {
  await withModelFallbackWorkspace(async (workspace) => {
    await writeFallbackAuthStore(workspace.agentDir);
    await fn(workspace);
  });
}

function mockAllProvidersOverloaded() {
  runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
    const attemptParams = params as { provider: string; modelId: string; authProfileId?: string };
    if (attemptParams.provider === "openai" || attemptParams.provider === "groq") {
      return makeEmbeddedRunnerAttempt({
        providerRetryMaxRetries: 3,
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
  return recordedAttempts().filter((attempt) => attempt.provider === provider).length;
}

function expectProviderAttemptCounts(expected: { openai: number; groq: number }) {
  expect({ openai: countProviderAttempts("openai"), groq: countProviderAttempts("groq") }).toEqual(
    expected,
  );
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
    await withDefaultAuth(async ({ agentDir, workspaceDir }) => {
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
            : buildEmbeddedRunnerAssistant({ stopReason: "aborted" }),
          toolMetas: "wrote" in scenario ? [{ toolName: "write", replaySafe: false }] : [],
          ...("replayInvalid" in scenario ? { promptTimeoutOutcome: { replayInvalid: true } } : {}),
        }),
      );
      const result = await runEmbeddedFallback({ agentDir, workspaceDir }, "attempt-timeout");

      expectProviderAttemptCounts({ openai: 1, groq: scenario.fallback ? 1 : 0 });
      if (scenario.fallback) {
        expect(result.result.payloads?.[0]?.text).toBe("fallback ok");
        expect(result.result.meta.error).toBeUndefined();
        expect(recordedAttempts().map((attempt) => attempt.timeoutMs)).toEqual([5_000, 5_000]);
      }
    });
  });

  it.each(["thrown", "assistant"] as const)(
    "does not replay %s transcript turn assertions through retries or model fallback",
    async (surface) => {
      await withDefaultAuth(async ({ agentDir, workspaceDir }) => {
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
        const result = await runEmbeddedEntryFallback(
          { agentDir, workspaceDir },
          "transcript-assertion",
          {
            runId: "announce:requester-settle:test:transcript-assertion",
            fallbacksOverride: ["groq/mock-2", "groq/mock-3"],
          },
        ).catch((error: unknown) => error);

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
      // #58572: a user pin disables escalation, not same-model retries.
      mockPrimaryErrorThenFallbackSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const fallbackSteps: ModelFallbackStepFields[] = [];
      const run = runEmbeddedEntryFallback(
        { agentDir, workspaceDir },
        "user-model-override-rate-limit",
        {
          fallbacksOverride: [],
          modelFallbackAvailability: { kind: "disabled_by_model_override" },
          onFallbackStep: (step) => fallbackSteps.push(step),
        },
      );

      await expect(run).rejects.toMatchObject({
        name: "FailoverError",
        message:
          "Rate-limit recovery stopped after 3 automatic retries without a completed model response. Check completed work before trying again.",
        reason: "rate_limit",
        provider: "openai",
        model: "mock-1",
        rateLimitRetriesExhausted: 3,
        suspend: true,
      });
      expect(runEmbeddedAttemptMock.mock.calls.length).toBeGreaterThan(2);
      expect(recordedAttempts().every((attempt) => attempt.provider === "openai")).toBe(true);
      expect(fallbackSteps.map((step) => step.fallbackStepFinalOutcome)).toEqual([
        "chain_exhausted",
      ]);
      expect(fallbackSteps[0]?.fallbackStepToModel).toBeUndefined();
    });
  });

  it("keeps fallback enabled for auto-selected routes and traces the winning execution", async () => {
    await withDefaultAuth(async ({ agentDir, workspaceDir }) => {
      mockPrimaryOverloadedThenFallbackSuccess();
      const { decisionWork, result } = await captureRoutingDecisionWork(() =>
        runEmbeddedEntryFallback({ agentDir, workspaceDir }, "execution-trace-fallback", {
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
      expect(recordedAttempts().map((attempt) => attempt.provider)).toContain("groq");
      expect(result.result.meta.executionTrace).toMatchObject({
        winnerProvider: "groq",
        winnerModel: "mock-2",
        fallbackUsed: true,
        runner: "embedded",
        attempts: [
          { provider: "openai", model: "mock-1", result: "candidate_failed", reason: "overloaded" },
          { provider: "groq", model: "mock-2", result: "success" },
        ],
      });
      const terminalReceipt = {
        requested: { provider: "openai", model: "mock-1" },
        effective: { provider: "groq", model: "mock-2" },
        rerouted: true,
      };
      expect(result.result.meta.agentMeta?.terminalReceipt).toMatchObject(terminalReceipt);
      expect(result.terminal.metadata.terminalReceipt).toMatchObject(terminalReceipt);
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
    await withDefaultAuth(async ({ agentDir, workspaceDir }) => {
      const runId = "run:execution-trace-skipped-fallback";
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
          runEmbeddedEntryFallback({ agentDir, workspaceDir }, "execution-trace-skipped-fallback", {
            runId,
          }),
        ).rejects.toThrow("All models failed");
        expectAttemptOrder(profileAttempts("openai", 4));
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
    await withDefaultAuth(async ({ agentDir, workspaceDir }) => {
      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeEmbeddedRunnerAttempt({
          toolMetas: [{ toolName: "write", meta: "path=out.txt" }],
          lastAssistant: buildEmbeddedRunnerAssistant({}),
        }),
      );

      const cfg = makeModelFallbackConfig();
      setRuntimeConfigSnapshot(cfg, cfg);
      const result = await runEmbeddedAgent({
        ...embeddedParams(
          {
            agentDir,
            workspaceDir,
            sessionKey: "agent:test:tool-side-effect-terminal",
            runId: "run:tool-side-effect-terminal",
          },
          cfg,
          "session:tool-side-effect-terminal",
        ),
        prompt: "write the file",
        provider: "openai",
        model: "mock-1",
      });

      expect(result.meta.toolSummary).toMatchObject({ calls: 1, tools: ["write"] });
      expect(
        classifyEmbeddedAgentRunResultForModelFallback({
          provider: "openai",
          model: "gpt-5.4",
          result,
        }),
      ).toBeNull();
    });
  });

  it.each(["assistant", "prompt"] as const)(
    "exhausts bounded recovery on organization TPM exhaustion from %s before fallback",
    async (source) => {
      await withDefaultAuth(async ({ agentDir, workspaceDir }) => {
        const message =
          "429 Rate limit reached for mock-1 in organization org-example on tokens per min (TPM): Limit 10000, Used 9900, Requested 200. Please try again in 90s.";
        const config = makeModelFallbackConfig();
        config.agents!.defaults!.model = { primary: "openai/mock-1", fallbacks: ["openai/mock-2"] };
        runEmbeddedAttemptMock.mockImplementation(async (params) => {
          const { modelId } = params as EmbeddedAttemptParams;
          const failed = modelId === "mock-1";
          return makeEmbeddedRunnerAttempt({
            assistantTexts: failed ? [] : ["fallback ok"],
            ...(failed && source === "prompt"
              ? { terminal: { kind: "failed", source: "prompt", error: new Error(message) } }
              : {
                  lastAssistant: buildEmbeddedRunnerAssistant({
                    model: modelId ?? "mock-1",
                    stopReason: failed ? "error" : "stop",
                    ...(failed
                      ? { errorMessage: message }
                      : { content: [{ type: "text", text: "fallback ok" }] }),
                  }),
                }),
          });
        });
        const run = (turn: string) =>
          runEmbeddedFallback({ agentDir, workspaceDir }, `organization-tpm:${source}:${turn}`, {
            config,
          });
        const result = await run("first");
        expect(result.result.payloads?.[0]?.text).toContain("fallback ok");
        const expectedModels = [...Array<string>(10).fill("mock-1"), "mock-2"];
        expect(recordedAttempts().map((attempt) => attempt.modelId)).toEqual(expectedModels);
        expect(sleepWithAbortMock.mock.calls.map(([delay]) => delay)).toEqual(
          Array<number>(9).fill(90_000),
        );
        const stats = (await readFallbackUsageStats(agentDir))["openai:p1"];
        expect(stats).toMatchObject({ cooldownReason: "rate_limit", cooldownModel: "mock-1" });
        expect((stats?.cooldownUntil ?? 0) - (stats?.lastFailureAt ?? 0)).toBe(30_000);

        runEmbeddedAttemptMock.mockClear();
        sleepWithAbortMock.mockClear();
        const next = await run("during-cooldown");
        expect(next.result.payloads?.[0]?.text).toContain("fallback ok");
        expect(recordedAttempts().map((attempt) => attempt.modelId)).toEqual(expectedModels);
        expect(sleepWithAbortMock.mock.calls.map(([delay]) => delay)).toEqual(
          Array<number>(9).fill(90_000),
        );
      });
    },
  );

  type AssistantFailure = [
    name: string,
    messages: string | string[],
    reason: string,
    primaryAttempts: number | undefined,
    health?: "missing" | "fallback" | "server" | "timeout" | "overloaded",
    sleeps?: number,
    provider?: string,
  ];
  const assistantFailures: AssistantFailure[] = [
    ["no endpoints", NO_ENDPOINTS_FOUND_ERROR_MESSAGE, "model_not_found", 1],
    ["default timeout", "LLM request timed out.", "timeout", 4],
    [
      "402 quota refresh",
      "402 You have reached your subscription quota limit. Please wait for automatic quota refresh in the rolling time window, upgrade to a higher plan, or use a Pay-As-You-Go API Key for unlimited access.",
      "rate_limit",
      1,
    ],
    [
      "Azure no details",
      NO_ERROR_DETAILS_MESSAGE,
      "no_error_details",
      undefined,
      "missing",
      0,
      "azure-foundry",
    ],
    [
      "per-day cap (#147546)",
      REAL_TRANSPORT_PER_DAY_CAP_ERROR_MESSAGE,
      "rate_limit",
      1,
      "fallback",
      0,
    ],
    ["HTTP 502", CLOUDFLARE_502_ERROR_PAYLOAD, "server_error", 4, "server"],
    [
      "transport failure",
      ["terminated", "stream_read_error", "Request failed"],
      "timeout",
      4,
      "timeout",
      3,
    ],
    ["service unavailable", "LLM error: service unavailable", "overloaded", 4, "overloaded", 3],
  ];
  it.each(assistantFailures)(
    "falls back after %s with the correct retry and profile-health policy",
    async (name, messages, reason, primaryAttempts, health, sleeps, provider = "openai") => {
      for (const [index, message] of (typeof messages === "string"
        ? [messages]
        : messages
      ).entries()) {
        const runName = `${name.replaceAll(/[^a-z0-9]+/gi, "-")}:${index}`;
        await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
          await writeFallbackAuthStore(agentDir, undefined, { primaryProvider: provider });
          runEmbeddedAttemptMock.mockClear();
          computeBackoffMock.mockClear();
          sleepWithAbortMock.mockClear();
          mockPrimaryErrorThenFallbackSuccess(message, { primaryProvider: provider });

          const result = await runEmbeddedFallback(
            { agentDir, workspaceDir },
            runName,
            provider === "openai" ? {} : { provider, config: makeModelFallbackConfig(provider) },
          );

          expectFallbackSuccess(result);
          expect(result.attempts[0]?.reason).toBe(reason);
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
            expectNoBackoffWithSleeps(sleeps);
          }
        });
      }
    },
  );

  it.each(["direct", "outer-fallback"] as const)(
    "assigns session suspension to the %s run owner",
    async (mode) => {
      await withDefaultAuth(async ({ agentDir, workspaceDir }) => {
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
        const sessionLookup = vi
          .spyOn(await import("./command/session.js"), "resolveStoredSessionKeyForSessionId")
          .mockResolvedValue({
            sessionKey: params.sessionKey,
            storePath: `${agentDir}/sessions.json`,
          });
        const persistSuspension = vi
          .spyOn(await import("../config/sessions/session-accessor.js"), "patchSessionEntryCore")
          .mockResolvedValue(null);
        const { suspendSession } =
          await vi.importActual<typeof import("./session-suspension.js")>(
            "./session-suspension.js",
          );
        try {
          if (mode === "direct") {
            setRuntimeConfigSnapshot(params.config, params.config);
            await expect(
              runEmbeddedAgent({
                ...embeddedParams(params, params.config, sessionId),
                lane: params.lane,
                provider: "openai",
                model: "mock-1",
              }),
            ).rejects.toThrow();
          } else {
            const result = await runEmbeddedFallback(
              { agentDir, workspaceDir },
              `${mode}-suspension`,
              params,
            );
            expect(result.provider).toBe("groq");
          }
          // Join the owner's write queue; captured callbacks bypass the exported mock.
          await suspendSession({
            cfg: undefined,
            sessionId,
            reason: "manual",
            failedProvider: "openai",
            failedModel: "mock-1",
          });
          if (mode === "direct") {
            expect(sessionLookup).toHaveBeenCalledExactlyOnceWith({
              cfg: params.config,
              sessionId,
              agentId: "test",
            });
            expect(persistSuspension).toHaveBeenCalledOnce();
            const [scope, update] = persistSuspension.mock.calls[0]!;
            expect(scope).toEqual({
              sessionKey: params.sessionKey,
              storePath: `${agentDir}/sessions.json`,
            });
            expect(await update({ sessionId, updatedAt: 0 }, {})).toMatchObject({
              quotaSuspension: {
                state: "suspended",
                reason: "quota_exhausted",
                failedProvider: "openai",
                failedModel: "mock-1",
              },
            });
          } else {
            expect(sessionLookup).not.toHaveBeenCalled();
            expect(persistSuspension).not.toHaveBeenCalled();
            expect(suspendSessionMock).not.toHaveBeenCalled();
          }
        } finally {
          sessionLookup.mockRestore();
          persistSuspension.mockRestore();
        }
      });
    },
  );

  it("surfaces a bounded overloaded summary when every fallback candidate is overloaded", async () => {
    await withDefaultAuth(async ({ agentDir, workspaceDir }) => {
      mockAllProvidersOverloaded();

      const thrown = await runEmbeddedFallback({ agentDir, workspaceDir }, "all-overloaded").catch(
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/^All models failed \(2\): /);
      expect((thrown as Error).message).toMatch(
        /openai\/mock-1: .* \(overloaded\) \| groq\/mock-2: .* \(overloaded\)/,
      );

      expectAttemptOrder([...profileAttempts("openai", 4), ...profileAttempts("groq", 4)]);
      expectNoBackoffWithSleeps(6);
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

      const result = await runEmbeddedFallback(
        { agentDir, workspaceDir },
        "overloaded-probe-fallback",
      );

      expect(result.provider).toBe("groq");
      expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });
    });
  });

  it("keeps overloaded failures provider-scoped across turns while continuing fallback", async () => {
    await withDefaultAuth(async ({ agentDir, workspaceDir }) => {
      for (const turn of ["first", "second"]) {
        runEmbeddedAttemptMock.mockClear();
        computeBackoffMock.mockClear();
        sleepWithAbortMock.mockClear();
        mockPrimaryOverloadedThenFallbackSuccess();
        const result = await runEmbeddedFallback(
          { agentDir, workspaceDir },
          `overloaded-two-turns:${turn}`,
        );
        expect(result.provider).toBe("groq");
        const usageStats = await readFallbackUsageStats(agentDir);
        expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
        expect(usageStats["openai:p1"]?.failureCounts?.overloaded).toBeUndefined();
        expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });
        expectNoBackoffWithSleeps(3);
        if (turn === "first") {
          expect(result.model).toBe("mock-2");
          expect(result.attempts[0]?.reason).toBe("overloaded");
          expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");
          expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");
        }
      }
    });
  });

  it.each([
    ["HTTP 502", "assistant", CLOUDFLARE_502_ERROR_PAYLOAD, "server_error", 2, 4],
    ["overloaded (#58348)", "assistant", OVERLOADED_ERROR_PAYLOAD, "overloaded", 3, 4],
    [
      "long-window assistant (#58572)",
      "assistant",
      LONG_RATE_LIMIT_ERROR_MESSAGE,
      "rate_limit",
      3,
      1,
    ],
    ["long-window prompt", "prompt", LONG_RATE_LIMIT_ERROR_MESSAGE, "rate_limit", 3, 1],
    [
      "structured prompt",
      "structured",
      "You've reached your Codex subscription usage limit.",
      "rate_limit",
      2,
      1,
    ],
  ] as const)(
    "bounds profile rotation before falling back after %s",
    async (_name, source, message, reason, profiles, primaryAttempts) => {
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

        const result = await runEmbeddedFallback(
          { agentDir, workspaceDir },
          `rotation:${source}:${reason}`,
        );

        expectFallbackSuccess(result);
        expectAttemptOrder([
          ...profileAttempts("openai", primaryAttempts),
          ...profileAttempts("openai", 1, 2),
          ...profileAttempts("groq"),
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
            const primaryCalls = recordedAttempts().filter(
              (params) => params.provider === "openai",
            );
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

      const result = await runEmbeddedFallback(
        { agentDir, workspaceDir },
        "rate-limit-retry-limit-fallback",
      );

      expect(result).toMatchObject({ provider: "openai", model: "mock-1" });
      expect(result.attempts).toEqual([]);

      expectProviderAttemptCounts({ openai: 1, groq: 0 });
    });
  });
});
