// Exercises ordered provider faults through the embedded runner failover boundary.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ContextEngine } from "../context-engine/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "./embedded-agent-runner/result-fallback-classifier.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { isFailoverError } from "./failover-error.js";
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
import { drainScenarioDatabase } from "./test-helpers/embedded-run-scenario.test-support.js";

type ProviderFault =
  | { status: 200; text: string }
  | { status: 401 }
  | { status: 402 }
  | { status: 413 }
  | { status: 429; window: "short" | "long" }
  // Anthropic's header-only session-window shape (#148558/#143274).
  | { status: 429; window: "header-floor"; retryAfterSeconds: number; maxRetryDelayMs: number }
  | { status: 500 }
  | { status: "context_overflow" };

type AttemptObservation = {
  provider: string;
  model: string;
  profileId?: string;
  fault: ProviderFault;
};

type ScenarioOutcome = Awaited<ReturnType<typeof runScenario>>;

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-fault-sequences-");
const runEmbeddedAttemptMock =
  vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
const { sleepWithAbortMock } = vi.hoisted(() => ({
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

vi.mock("./models-config.js", async () => {
  const actual = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
  return { ...actual, ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })) };
});

type ProductionRunEmbeddedAgent = typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let runEmbeddedAgentWithPreparedAdmission: ProductionRunEmbeddedAgent;
let runWithModelFallback: typeof import("./model-fallback-runner.js").runWithModelFallback;
let captureRoutingDecisionWork: typeof import("./test-helpers/model-routing-decision-e2e-fixtures.js").captureRoutingDecisionWork;
let createModelRoutingTestAdmission: typeof import("./test-helpers/model-routing-decision-e2e-fixtures.js").createModelRoutingTestAdmission;
let ensureAuthProfileStore: typeof import("./auth-profiles/store-runtime.js").ensureAuthProfileStore;
let saveAuthProfileStore: typeof import("./auth-profiles/store-runtime.js").saveAuthProfileStore;
let createOpenClawDatabaseMaintenanceScope: typeof import("../state/openclaw-state-db-async-lifecycle.js").createOpenClawDatabaseMaintenanceScope;
let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;

beforeAll(async () => {
  vi.resetModules();
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
  });
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: () => 0,
    sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
  });
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));

  ({ createOpenClawDatabaseMaintenanceScope } =
    await import("../state/openclaw-state-db-async-lifecycle.js"));
  ({ setRuntimeConfigSnapshot } = await import("../config/config.js"));
  runEmbeddedAgentWithPreparedAdmission = (await import("./embedded-agent-runner/run.js"))
    .runEmbeddedAgent;
  ({ runWithModelFallback } = await import("./model-fallback-runner.js"));
  ({ captureRoutingDecisionWork, createModelRoutingTestAdmission } =
    await import("./test-helpers/model-routing-decision-e2e-fixtures.js"));
  ({ ensureAuthProfileStore, saveAuthProfileStore } =
    await import("./auth-profiles/store-runtime.js"));
});

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  runEmbeddedAttemptMock.mockReset();
  sleepWithAbortMock.mockClear();
});

function makeProviderConfig(fallbacks: string[]): OpenClawConfig {
  const provider = (modelIds: string[]) => ({
    api: "openai-responses" as const,
    apiKey: "test-key",
    baseUrl: "https://example.test",
    models: modelIds.map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 2_048,
    })),
  });
  return {
    agents: {
      defaults: { model: { primary: "openai/mock-1", fallbacks } },
      entries: { test: {} },
    },
    models: {
      providers: {
        openai: provider(["mock-1"]),
        groq: provider(["mock-2", "mock-3"]),
      },
    },
  };
}

async function withScenarioWorkspace<T>(
  run: (paths: { agentDir: string; workspaceDir: string }) => Promise<T>,
): Promise<T> {
  const root = sessionDirs.make();
  const agentDir = path.join(root, "agents", "test", "agent");
  const workspaceDir = path.join(root, "workspace");
  await Promise.all([
    fs.mkdir(agentDir, { recursive: true }),
    fs.mkdir(workspaceDir, { recursive: true }),
  ]);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  try {
    return await run({ agentDir, workspaceDir });
  } finally {
    random.mockRestore();
    await drainScenarioDatabase(path.join(agentDir, "openclaw-agent.sqlite"));
  }
}

function writeProfiles(agentDir: string, profiles: { openai: 1 | 2; groq?: boolean }): void {
  const entries: Array<[string, string, string, number]> = [
    ["openai:p1", "openai", "openai-one", 1],
  ];
  if (profiles.openai === 2) {
    entries.push(["openai:p2", "openai", "openai-two", 2]);
  }
  if (profiles.groq) {
    entries.push(["groq:p1", "groq", "groq-one", 3]);
  }
  saveAuthProfileStore(
    {
      version: 1,
      profiles: Object.fromEntries(
        entries.map(([id, provider, key]) => [id, { type: "api_key", provider, key }] as const),
      ),
      usageStats: Object.fromEntries(
        entries.map((entry) => [entry[0], { lastUsed: entry[3] }] as const),
      ),
    },
    agentDir,
  );
}

function makeAttemptForFault(
  fault: ProviderFault,
  ref: { provider: string; model: string },
): EmbeddedRunAttemptResult {
  if (fault.status === 200) {
    return makeEmbeddedRunnerAttempt({
      assistantTexts: [fault.text],
      lastAssistant: buildEmbeddedRunnerAssistant({
        provider: ref.provider,
        model: ref.model,
        content: [{ type: "text", text: fault.text }],
      }),
    });
  }
  if (fault.status === 429 && fault.window === "header-floor") {
    // Keep usage/quota keywords out: only the header reveals the retry floor.
    return makeEmbeddedRunnerAttempt({
      providerRetryMaxRetries: 3,
      providerRetryMaxDelayMs: fault.maxRetryDelayMs,
      lastAssistant: buildEmbeddedRunnerAssistant({
        provider: ref.provider,
        model: ref.model,
        stopReason: "error",
        errorMessage:
          "This request would exceed your account's rate limit. Please try again later.",
        errorType: "rate_limit_error",
        errorBody: JSON.stringify({ headers: { "retry-after": String(fault.retryAfterSeconds) } }),
      }),
    });
  }
  if (fault.status === 500) {
    return makeEmbeddedRunnerAttempt({
      // Model fallback scenarios exercise exhaustion of a provider-reported cap.
      providerRetryMaxRetries: 3,
      terminal: {
        kind: "failed",
        source: "prompt",
        error: Object.assign(
          new Error(
            '500 Internal Server Error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."}}',
          ),
          { status: 500 },
        ),
      },
    });
  }
  const errorMessage =
    fault.status === 401
      ? "401 Unauthorized: invalid API key"
      : fault.status === 402
        ? "402 Payment Required: insufficient credits"
        : fault.status === 413
          ? // Groq's verbatim refusal for a single request larger than the whole per-minute
            // token limit: a size ceiling wearing rate-limit clothes.
            "413 Request too large for model `mock-1` in organization `org_x` service tier " +
            "`on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, please reduce " +
            "your message size and try again."
          : fault.status === 429
            ? fault.window === "short"
              ? "429 Too Many Requests: rate limit exceeded"
              : "429 Too Many Requests: subscription usage limit reached"
            : "Prompt is too long for this model's context window";
  return makeEmbeddedRunnerAttempt({
    lastAssistant: buildEmbeddedRunnerAssistant({
      provider: ref.provider,
      model: ref.model,
      stopReason: "error",
      errorMessage,
    }),
  });
}

function installFaultScript(faults: ProviderFault[], observations: AttemptObservation[]): void {
  let index = 0;
  runEmbeddedAttemptMock.mockImplementation(async (params) => {
    const fault = faults[index];
    if (!fault) {
      throw new Error(`unexpected provider attempt ${index + 1}`);
    }
    index += 1;
    const ref = { provider: params.provider, model: params.modelId };
    observations.push({ ...ref, profileId: params.authProfileId, fault });
    return { ...makeAttemptForFault(fault, ref), sessionIdUsed: params.sessionId };
  });
}

async function runScenario(params: {
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  runId: string;
}) {
  const { replaceSessionEntry } = await import("../config/sessions/session-accessor.js");
  const sessionTarget = {
    agentId: "test",
    sessionId: `session:${params.runId}`,
    sessionKey: `agent:test:${params.runId}`,
    storePath: path.join(params.agentDir, "openclaw-agent.sqlite"),
  };
  // Every fallback candidate belongs to the same outer admitted run.
  const preparedRunAdmission = createModelRoutingTestAdmission({
    cfg: params.config,
    runId: params.runId,
    agentId: sessionTarget.agentId,
    boundary: "provider-fault-sequence",
  });
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  try {
    // The synthetic attempt skips transcript creation; seed the real row so the
    // runner claims its writer normally before entering compaction recovery.
    await replaceSessionEntry(sessionTarget, {
      sessionId: sessionTarget.sessionId,
      updatedAt: Date.now(),
    });
    const outcome = await maintenance.run(() =>
      runWithModelFallback<EmbeddedAgentRunResult>({
        cfg: params.config,
        provider: "openai",
        model: "mock-1",
        runId: params.runId,
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
        agentDir: params.agentDir,
        classifyResult: classifyEmbeddedAgentRunResultForModelFallback,
        mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
        run: async (provider, model, options) =>
          await runEmbeddedAgentWithPreparedAdmission({
            preparedRunAdmission,
            agentId: sessionTarget.agentId,
            sessionId: sessionTarget.sessionId,
            sessionKey: sessionTarget.sessionKey,
            sessionTarget,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            config: params.config,
            prompt: "hello",
            provider,
            model,
            authProfileIdSource: "auto",
            allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
            isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
            timeoutMs: 250,
            runId: params.runId,
            enqueue: async (task) => await task(),
          }),
      }),
    );
    return { kind: "result" as const, ...outcome };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return { kind: "error" as const, error };
  } finally {
    try {
      // Profile failure bookkeeping can outlive the completed reply.
      await maintenance.close();
    } finally {
      preparedRunAdmission.close();
    }
  }
}

async function readUsageStats(agentDir: string) {
  return ensureAuthProfileStore(agentDir, { syncExternalCli: false }).usageStats ?? {};
}

async function withFaults(
  runId: string,
  faults: ProviderFault[],
  profiles: Parameters<typeof writeProfiles>[1],
  fallbacks: string[],
  check: (context: {
    outcome: ScenarioOutcome;
    observations: AttemptObservation[];
    usageStats: Awaited<ReturnType<typeof readUsageStats>>;
    startedAt: number;
  }) => void,
) {
  await withScenarioWorkspace(async (paths) => {
    writeProfiles(paths.agentDir, profiles);
    const observations: AttemptObservation[] = [];
    installFaultScript(faults, observations);
    const startedAt = Date.now();
    const outcome = await runScenario({ ...paths, config: makeProviderConfig(fallbacks), runId });
    check({ outcome, observations, usageStats: await readUsageStats(paths.agentDir), startedAt });
  });
}

function expectResult(outcome: ScenarioOutcome): Extract<ScenarioOutcome, { kind: "result" }> {
  assert(outcome.kind === "result", "expected fault sequence to recover");
  return outcome;
}

function expectError(outcome: ScenarioOutcome): Error & { attempts?: unknown[] } {
  assert(outcome.kind === "error", "expected fault sequence to fail");
  return outcome.error;
}

const retryDelays = () => sleepWithAbortMock.mock.calls.map(([delay]) => delay);
const attemptRoutes = (observations: AttemptObservation[]) =>
  observations.map(({ provider, model, profileId }) => [provider, model, profileId]);

async function expectPreparationInvalidationToDropRoutingWork(
  mode: "close" | "replace",
): Promise<void> {
  await withScenarioWorkspace(async ({ agentDir, workspaceDir }) => {
    const runId = `route-preparation-${mode}`;
    const config = makeProviderConfig([]);
    const auditConfig = { ...config, logging: { audit: { executionIdentity: true } } };
    writeProfiles(agentDir, { openai: 1 });
    runEmbeddedAttemptMock.mockResolvedValue(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["unexpected dispatch"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          provider: "openai",
          model: "mock-1",
          stopReason: "stop",
          content: [{ type: "text", text: "unexpected dispatch" }],
        }),
      }),
    );
    const preparedAdmission = createModelRoutingTestAdmission({
      cfg: auditConfig,
      runId,
      boundary: "route-preparation-e2e",
    });
    let replacementAdmission: ReturnType<typeof createModelRoutingTestAdmission> | undefined;
    const reachedPreparation = createDeferredCore();
    const releasePreparation = createDeferredCore();
    const realMkdir = fs.mkdir.bind(fs);
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      if (String(target) === workspaceDir) {
        reachedPreparation.resolve();
        await releasePreparation.promise;
      }
      return await realMkdir(target, options);
    });
    let run: ReturnType<ProductionRunEmbeddedAgent> | undefined;
    try {
      const { decisionWork } = await captureRoutingDecisionWork(async () => {
        run = runEmbeddedAgentWithPreparedAdmission({
          preparedRunAdmission: preparedAdmission,
          sessionId: `session:${runId}`,
          sessionKey: `agent:test:${runId}`,
          workspaceDir,
          agentDir,
          config,
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          timeoutMs: 250,
          runId,
          enqueue: async (task) => await task(),
        });
        await Promise.race([
          reachedPreparation.promise,
          run.then(() => {
            throw new Error("embedded run settled before attempt preparation");
          }),
        ]);
        if (mode === "close") {
          preparedAdmission.close();
        } else {
          replacementAdmission = createModelRoutingTestAdmission({
            cfg: auditConfig,
            runId,
            boundary: "route-preparation-replacement-e2e",
          });
          await replacementAdmission.admit("embedded");
        }
        releasePreparation.resolve();
        await expect(run).rejects.toThrow(
          "embedded attempt reached dispatch without an active admitted run",
        );
      });

      expect(decisionWork).toHaveLength(0);
      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    } finally {
      releasePreparation.resolve();
      replacementAdmission?.close();
      preparedAdmission.close();
      // The rejection is observed above; join all run work before restoring its checkpoint.
      await Promise.allSettled(run ? [run] : []);
      mkdirSpy.mockRestore();
    }
  });
}

it.each(["close", "replace"] as const)(
  "drops routing work after admission %s during preparation",
  expectPreparationInvalidationToDropRoutingWork,
);

it("recovers four short rate limits with the default budget without rotating profiles", async () => {
  const faults = [
    ...Array.from({ length: 4 }, () => ({ status: 429, window: "short" }) as const),
    { status: 200, text: "fifth attempt ok" },
  ] satisfies ProviderFault[];

  await withFaults(`same-model-${faults.length}`, faults, { openai: 2 }, [], (context) => {
    const { observations, usageStats } = context;
    const outcome = expectResult(context.outcome);

    expect(observations).toHaveLength(faults.length);
    expect(
      observations.map(({ provider, model, profileId }) => ({ provider, model, profileId })),
    ).toEqual(faults.map(() => ({ provider: "openai", model: "mock-1", profileId: "openai:p1" })));
    expect(retryDelays()).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(outcome).toMatchObject({ provider: "openai", model: "mock-1", attempts: [] });
    expect(outcome.result.payloads?.[0]?.text).toContain("fifth attempt ok");
    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(usageStats["openai:p1"]?.disabledUntil).toBeUndefined();
  });
});

it.each([false, true])("walks the mixed fault chain (exhausted=%s)", async (exhausted) => {
  await withFaults(
    exhausted ? "all-faults" : "mixed-fault-chain",
    [
      { status: 429, window: "long" },
      { status: 401 },
      ...Array.from({ length: 4 }, () => ({ status: 500 as const })),
      exhausted ? { status: 402 } : { status: 200, text: "fallback chain ok" },
    ],
    { openai: 2, groq: true },
    ["groq/mock-2", "groq/mock-3"],
    ({ outcome: raw, observations, usageStats }) => {
      expect(attemptRoutes(observations)).toEqual([
        ["openai", "mock-1", "openai:p1"],
        ["openai", "mock-1", "openai:p2"],
        ...Array.from({ length: 4 }, () => ["groq", "mock-2", "groq:p1"]),
        ["groq", "mock-3", "groq:p1"],
      ]);
      expect(retryDelays()).toEqual([1_000, 2_000, 4_000]);
      expect(usageStats["openai:p1"]?.cooldownReason).toBe("rate_limit");
      expect(usageStats["openai:p2"]?.cooldownReason).toMatch(/^auth/);
      if (exhausted) {
        const error = expectError(raw);
        expect(error.message).toMatch(/^All models failed \(3\): /);
        expect(error.message).toMatch(
          /openai\/mock-1: .* \(auth(?:_permanent)?\) \| groq\/mock-2: .* \(server_error\) \| groq\/mock-3: .* \(billing\)/,
        );
        assert(isFailoverError(error), "expected typed failover exhaustion");
        expect(error.attempts).toMatchObject([
          { provider: "openai", model: "mock-1", reason: "auth" },
          { provider: "groq", model: "mock-2", reason: "server_error" },
          { provider: "groq", model: "mock-3", reason: "billing" },
        ]);
        expect(usageStats["groq:p1"]?.disabledReason).toBe("billing");
      } else {
        const outcome = expectResult(raw);
        expect(outcome).toMatchObject({
          provider: "groq",
          model: "mock-3",
          attempts: [
            { provider: "openai", model: "mock-1", reason: expect.stringMatching(/^auth/) },
            { provider: "groq", model: "mock-2", reason: "server_error" },
          ],
        });
        expect(outcome.result.payloads?.[0]?.text).toContain("fallback chain ok");
        expect(usageStats["openai:p1"]?.failureCounts?.rate_limit).toBe(1);
        expect(usageStats["openai:p2"]?.failureCounts?.auth).toBe(1);
        expect(usageStats["groq:p1"]?.cooldownUntil).toBeUndefined();
      }
    },
  );
});

it.each(["model fallback", "auth profile", "exhausted profiles"] as const)(
  "handles a header-only multi-hour 429 with %s",
  async (recovery) => {
    const modelFallback = recovery === "model fallback";
    const exhausted = recovery === "exhausted profiles";
    const rateLimit: ProviderFault = {
      status: 429,
      window: "header-floor",
      retryAfterSeconds: 9897,
      maxRetryDelayMs: 30_000,
    };
    await withFaults(
      `header-floor-${recovery.replaceAll(" ", "-")}`,
      [rateLimit, exhausted ? rateLimit : { status: 200, text: "backup recovered" }],
      { openai: modelFallback ? 1 : 2, groq: modelFallback },
      modelFallback ? ["groq/mock-2"] : [],
      ({ outcome, observations, usageStats }) => {
        expect(attemptRoutes(observations)).toEqual([
          ["openai", "mock-1", "openai:p1"],
          modelFallback ? ["groq", "mock-2", "groq:p1"] : ["openai", "mock-1", "openai:p2"],
        ]);
        expect(retryDelays()).not.toContain(9_897_000);
        if (exhausted) {
          const error = expectError(outcome);
          expect(error).toMatchObject({ reason: "rate_limit" });
          expect(error.message).toMatch(/try again/i);
        } else {
          expect(expectResult(outcome).result.payloads?.[0]?.text).toBe("backup recovered");
        }
        expect(usageStats["openai:p1"]?.cooldownReason).toBe("rate_limit");
        if (exhausted) {
          expect(usageStats["openai:p2"]?.cooldownReason).toBe("rate_limit");
        }
      },
    );
  },
);

it("persists a ten-minute initial billing disable and surfaces billing copy for 402", async () => {
  await withFaults(
    "billing-402",
    [{ status: 402 }],
    { openai: 1 },
    [],
    ({ outcome, observations, usageStats, startedAt }) => {
      const error = expectError(outcome);

      expect(observations).toMatchObject([
        { provider: "openai", model: "mock-1", profileId: "openai:p1", fault: { status: 402 } },
      ]);
      expect(error.message).toContain("returned a billing error");
      expect(error.message).toContain(
        "check your account's balance and usage limits before trying again.",
      );
      expect(usageStats["openai:p1"]?.disabledReason).toBe("billing");
      expect(usageStats["openai:p1"]?.failureCounts?.billing).toBe(1);
      expect(usageStats["openai:p1"]?.disabledUntil).toBeGreaterThanOrEqual(
        startedAt + 10 * 60 * 1_000,
      );
      expect(usageStats["openai:p1"]?.disabledUntil).toBeLessThanOrEqual(
        Date.now() + 10 * 60 * 1_000,
      );
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    },
  );
});

it.each([false, true])("surfaces blocked oversized input (request ceiling=%s)", async (ceiling) => {
  const runId = ceiling ? "request-size-ceiling" : "context-overflow";
  const fault: ProviderFault = ceiling ? { status: 413 } : { status: "context_overflow" };
  await withFaults(
    runId,
    [fault],
    { openai: 1, groq: ceiling },
    ceiling ? ["groq/mock-2"] : [],
    ({ outcome: raw, observations, usageStats }) => {
      const outcome = expectResult(raw);
      expect(observations).toHaveLength(1);
      expect(outcome.result.meta.error).toMatchObject({ kind: "context_overflow" });
      expect(outcome.result.payloads?.[0]).toMatchObject({
        isError: true,
        text: expect.stringContaining(
          ceiling ? "Try /reset (or /new)" : "Context overflow: prompt too large for the model",
        ),
      });
      if (ceiling) {
        // Compaction cannot admit the request; the eligible fallback stays unspent.
        expect(outcome.result.meta.livenessState).toBe("blocked");
        expect(outcome.attempts).toEqual([]);
      } else {
        expect(outcome.attempts).toEqual([
          expect.objectContaining({
            provider: "openai",
            model: "mock-1",
            reason: "context_overflow",
          }),
        ]);
      }
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    },
  );
});

it("compacts a provider overflow after settled writes and continues their recorded results", async () => {
  await withScenarioWorkspace(async ({ agentDir, workspaceDir }) => {
    const { resolveLogicalTurnContextEngines } = await import("../context-engine/registry.js");
    const {
      appendSessionTranscriptMessageByIdentity: appendMessage,
      readVisibleSessionTranscriptMessageEntries: readMessages,
    } = await import("../plugin-sdk/session-transcript-runtime.js");
    const runId = "provider-overflow-after-write";
    const target = {
      agentId: "test",
      sessionId: `session:${runId}`,
      sessionKey: `agent:test:${runId}`,
      storePath: path.join(agentDir, "openclaw-agent.sqlite"),
    };
    const user = { role: "user" as const, content: "hello", timestamp: 1 };
    const write = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "write-once", name: "write", arguments: {} }],
    });
    const written = makeTextToolResult("write-once", "write", "The change is saved.", false, 3);
    const overflow = buildEmbeddedRunnerAssistant({
      stopReason: "error",
      errorMessage:
        "Your input exceeds the context window of this model. Please adjust your input and try again.",
    });
    const messages = [user, write, written, overflow];
    const compact = vi.fn<ContextEngine["compact"]>(async ({ sessionTarget }) => {
      expect(sessionTarget).toMatchObject({ sessionId: target.sessionId });
      expect((await readMessages(target)).map((entry) => entry.message)).toEqual(messages);
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "The requested change is saved; report the result.",
          tokensBefore: 16_001,
          tokensAfter: 4_000,
        },
      };
    });
    const engine: ContextEngine = {
      info: { id: "legacy", name: "Legacy Context Engine" },
      ingest: async () => ({ ingested: false }),
      assemble: async ({ messages: context }) => ({ messages: context, estimatedTokens: 0 }),
      compact,
    };
    const ref = { engine, registeredId: "legacy" };
    vi.mocked(resolveLogicalTurnContextEngines).mockResolvedValueOnce({
      configured: ref,
      configuredId: "legacy",
      fallback: ref,
    });
    writeProfiles(agentDir, { openai: 2, groq: true });
    runEmbeddedAttemptMock
      .mockImplementationOnce(async (params) => {
        for (const message of messages) {
          await appendMessage({ ...target, message });
        }
        params.onUserMessagePersisted?.(user);
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          messagesSnapshot: messages,
          lastAssistant: overflow,
          currentAttemptCompletedAssistant: overflow,
          toolMetas: [{ toolName: "write", toolCallId: "write-once", replaySafe: false }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        });
      })
      .mockImplementationOnce(async (params) => {
        expect(params.prompt).not.toBe(user.content);
        expect(params.suppressNextUserMessagePersistence).toBe(true);
        expect(params.initialReplayState).toMatchObject({
          replayInvalid: true,
          hadPotentialSideEffects: true,
        });
        expect((await readMessages(target)).map((entry) => entry.message)).toEqual(messages);
        const assistant = buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "The change is saved." }],
        });
        await appendMessage({ ...target, message: assistant });
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          lastAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
          assistantTexts: ["The change is saved."],
          assistantTranscriptOwned: true,
        });
      });

    const outcome = expectResult(
      await runScenario({
        agentDir,
        workspaceDir,
        config: makeProviderConfig(["groq/mock-2"]),
        runId,
      }),
    );

    expect(compact).toHaveBeenCalledOnce();
    expect(runEmbeddedAttemptMock.mock.calls.map(([params]) => params)).toEqual([
      expect.objectContaining({
        provider: "openai",
        modelId: "mock-1",
        authProfileId: "openai:p1",
      }),
      expect.objectContaining({
        provider: "openai",
        modelId: "mock-1",
        authProfileId: "openai:p1",
      }),
    ]);
    expect(outcome.attempts).toEqual([]);
    expect(outcome.result.meta.error).toBeUndefined();
    expect(outcome.result.payloads).toEqual([
      expect.objectContaining({ text: "The change is saved." }),
    ]);
    const transcript = await readMessages(target);
    expect(transcript.filter(({ message }) => message.role === "user")).toHaveLength(1);
    expect(transcript.filter(({ message }) => message.role === "toolResult")).toHaveLength(1);
    expect(transcript.at(-1)?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The change is saved." }],
    });
  });
});
