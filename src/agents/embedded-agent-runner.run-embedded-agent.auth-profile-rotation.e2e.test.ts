import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
// End-to-end auth-profile rotation coverage for embedded runner retries.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import {
  resolveInlineProviderApiKeyUsageId,
  type AuthProfileFailureReason,
} from "./auth-profiles.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import type { AgentHarness } from "./harness/types.js";
import {
  buildEmbeddedRunnerAssistant as buildAssistant,
  makeEmbeddedRunnerAttempt as makeAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const resolveCopilotApiTokenMock = vi.fn();
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

const installRunEmbeddedMocks = () => {
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
    prepareProviderRuntimeAuth: async (params) => {
      if (params.provider !== "github-copilot") {
        return undefined;
      }
      const token = await resolveCopilotApiTokenMock(params.context.apiKey);
      return { apiKey: token.token, baseUrl: token.baseUrl, expiresAt: token.expiresAt };
    },
  });
  // mock-isolation: deterministic model resolution isolates profile rotation and provider auth.
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) => {
      const subscriptionModel = modelId === "chatgpt-mock";
      return {
        logicalRef: { provider, model: modelId },
        model: {
          ...makeModel(modelId, modelId),
          api: subscriptionModel ? "openai-chatgpt-responses" : "openai-responses",
          provider,
          baseUrl: subscriptionModel
            ? "https://chatgpt.com/backend-api/codex"
            : provider === "github-copilot"
              ? "https://api.copilot.example"
              : "https://example.com",
        },
        error: undefined,
        authStorage: { setRuntimeApiKey: vi.fn() },
        modelRegistry: {},
      };
    },
  }));
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
  });
  vi.doMock("./embedded-agent-runner/compact.js", () => ({
    compactEmbeddedAgentSessionDirect: vi.fn(async () => {
      throw new Error("compact should not run in auth profile rotation tests");
    }),
  }));
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
};

type ProductionRunEmbeddedAgent = typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
type TestRunEmbeddedAgent = (
  params: Omit<Parameters<ProductionRunEmbeddedAgent>[0], "admittedRunContext">,
) => ReturnType<ProductionRunEmbeddedAgent>;
let runEmbeddedAgent: TestRunEmbeddedAgent;
let ensureAuthProfileStore: typeof import("./auth-profiles/store-runtime.js").ensureAuthProfileStore;
let saveAuthProfileStore: typeof import("./auth-profiles/store-runtime.js").saveAuthProfileStore;
let createOpenClawDatabaseMaintenanceScope: typeof import("../state/openclaw-state-db-async-lifecycle.js").createOpenClawDatabaseMaintenanceScope;
let createDiagnosticLogRecordCaptureFn: typeof import("../logging/test-helpers/diagnostic-log-capture.js").createDiagnosticLogRecordCapture;
let cleanupLogCapture: (() => void) | undefined;
let resetLoggerFn: typeof import("../logging/logger.js").resetLogger;
let setLoggerOverrideFn: typeof import("../logging/logger.js").setLoggerOverride;
let registerAgentHarnessFn: typeof import("./harness/registry.js").registerAgentHarness;
let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ setRuntimeConfigSnapshot } = await import("../config/config.js"));
  runEmbeddedAgent = wrapRunWithTestPreparedAdmission(
    (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
  );
  // Fixture reads and runner writes must share the post-reset auth snapshot owner.
  ({ ensureAuthProfileStore, saveAuthProfileStore } =
    await import("./auth-profiles/store-runtime.js"));
  ({ createOpenClawDatabaseMaintenanceScope } =
    await import("../state/openclaw-state-db-async-lifecycle.js"));
  ({ createDiagnosticLogRecordCapture: createDiagnosticLogRecordCaptureFn } =
    await import("../logging/test-helpers/diagnostic-log-capture.js"));
  ({ resetLogger: resetLoggerFn, setLoggerOverride: setLoggerOverrideFn } =
    await import("../logging/logger.js"));
  ({ registerAgentHarness: registerAgentHarnessFn } = await import("./harness/registry.js"));
});

type RunEmbeddedAgentTestParams = Parameters<typeof runEmbeddedAgent>[0] & {
  authProfileStateMode?: "read-write" | "read-only";
};

async function runEmbeddedAgentInline(
  params: Pick<RunEmbeddedAgentTestParams, "agentDir" | "workspaceDir" | "runId"> &
    Partial<RunEmbeddedAgentTestParams>,
): Promise<Awaited<ReturnType<typeof runEmbeddedAgent>>> {
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  try {
    return await maintenance.run(() =>
      runEmbeddedAgent({
        sessionKey: `agent:test:${params.runId.slice(4)}`,
        sessionId: "session:test",
        config: makeConfig(),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        ...params,
        enqueue: async (task) => await task(),
      }),
    );
  } finally {
    // Success bookkeeping outlives the runner result; join it before reads or cleanup.
    await maintenance.close();
  }
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  vi.useRealTimers();
  runEmbeddedAttemptMock.mockReset();
  runEmbeddedAttemptMock.mockImplementation(async () => {
    throw new Error("unexpected extra runEmbeddedAttempt call");
  });
  resolveCopilotApiTokenMock.mockReset();
  resolveCopilotApiTokenMock.mockImplementation(async () => {
    throw new Error("unexpected extra Copilot token refresh");
  });
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanupLogCapture?.();
  cleanupLogCapture = undefined;
  setLoggerOverrideFn(null);
  resetLoggerFn();
});

const makeModel = (id: string, name: string) => ({
  id,
  name,
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 2048,
});

const makeConfig = (opts?: { fallbacks?: string[]; apiKey?: string }): OpenClawConfig =>
  ({
    agents: {
      defaults: { model: { fallbacks: opts?.fallbacks ?? [] } },
      entries: { test: {} },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: opts?.apiKey ?? "sk-test",
          baseUrl: "https://example.com",
          models: [makeModel("mock-1", "Mock 1")],
        },
      },
    },
  }) satisfies OpenClawConfig;

const makeAgentOverrideOnlyFallbackConfig = (agentId: string): OpenClawConfig => ({
  ...makeConfig(),
  agents: {
    defaults: { model: { fallbacks: [] } },
    entries: { [agentId]: { model: { fallbacks: ["openai/mock-2"] } } },
  },
});

const copilotModelId = "gpt-4o";

const makeCopilotConfig = (): OpenClawConfig =>
  ({
    agents: {
      entries: { test: {} },
    },
    models: {
      providers: {
        "github-copilot": {
          api: "openai-responses",
          baseUrl: "https://api.copilot.example",
          models: [makeModel(copilotModelId, "Copilot GPT-4o")],
        },
      },
    },
  }) satisfies OpenClawConfig;

const writeAuthStore = async (
  agentDir: string,
  opts?: {
    includeAnthropic?: boolean;
    order?: Record<string, string[]>;
    usageStats?: Record<
      string,
      {
        lastUsed?: number;
        cooldownUntil?: number;
        disabledUntil?: number;
        disabledReason?: AuthProfileFailureReason;
        failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
      }
    >;
  },
) => {
  // Store order and usageStats are the persisted inputs the rotation picker
  // uses to decide which profile should be cooled down or retried.
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openai:p1": { type: "api_key", provider: "openai", key: "sk-one" },
        "openai:p2": { type: "api_key", provider: "openai", key: "sk-two" },
        ...(opts?.includeAnthropic
          ? { "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-anth" } }
          : {}),
      },
      ...(opts?.order ? { order: opts.order } : {}),
      usageStats:
        opts?.usageStats ??
        ({
          "openai:p1": { lastUsed: 1 },
          "openai:p2": { lastUsed: 2 },
        } as Record<string, { lastUsed?: number }>),
    },
    agentDir,
  );
};

const writeCopilotAuthStore = async (agentDir: string, token = "gh-token") => {
  saveAuthProfileStore(
    createAuthProfileStoreFixture({
      "github-copilot:github": { type: "token", provider: "github-copilot", token },
    }),
    agentDir,
  );
};

const writeOpenAiCodexAuthStore = async (agentDir: string, includeBackup = false) => {
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openai:work": createApiKeyCredential("openai", "sk-codex"),
        ...(includeBackup
          ? {
              "openai:backup": { type: "api_key" as const, provider: "openai", key: "sk-backup" },
            }
          : {}),
      },
      ...(includeBackup ? { order: { openai: ["openai:work", "openai:backup"] } } : {}),
    },
    agentDir,
  );
};

const makeErrorAttempt = (
  overrides: Partial<AssistantMessage> = {},
  opts?: { currentAttempt?: boolean },
) => {
  const assistant = buildAssistant({ stopReason: "error", ...overrides });
  return makeAttempt({
    // Rotation-only fixtures disable retries; retry-budget cases override this.
    providerRetryMaxRetries: 0,
    assistantTexts: [],
    lastAssistant: assistant,
    ...(opts?.currentAttempt ? { currentAttemptAssistant: assistant } : {}),
  });
};

function makeSuccessfulAttempt(overrides: Partial<AssistantMessage> = {}, text = "ok") {
  return makeAttempt({
    assistantTexts: [text],
    lastAssistant: buildAssistant({
      stopReason: "stop",
      content: [{ type: "text", text }],
      ...overrides,
    }),
  });
}

const mockFailedThenSuccessfulAttempt = (
  errorMessage = "rate limit",
  model?: { provider: string; model: string },
) => {
  runEmbeddedAttemptMock
    .mockResolvedValueOnce(
      makeErrorAttempt({ errorMessage, ...model }, { currentAttempt: model !== undefined }),
    )
    .mockResolvedValueOnce(makeSuccessfulAttempt(model));
};

async function runAutoPinnedOpenAiTurn(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  authProfileId?: string;
  config?: OpenClawConfig;
}) {
  await runEmbeddedAgentInline({
    ...params,
    config: params.config ?? makeConfig(),
    authProfileId: params.authProfileId ?? "openai:p1",
  });
}

async function readUsageStats(agentDir: string) {
  return ensureAuthProfileStore(agentDir, { syncExternalCli: false }).usageStats ?? {};
}

function expectAuthProfileAttempts(profileIds: string[]) {
  expect(
    runEmbeddedAttemptMock.mock.calls.map(
      ([attempt]) => requireRecord(attempt, "embedded attempt params").authProfileId,
    ),
  ).toEqual(profileIds);
}

async function runAutoPinnedRotationCase(params: {
  errorMessage: string;
  sessionKey: string;
  runId: string;
  failureStage?: "assistant" | "prompt";
  exhaustTransientRetries?: boolean;
  config?: OpenClawConfig;
}) {
  runEmbeddedAttemptMock.mockReset();
  return withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
    await writeAuthStore(agentDir);
    // Exhaust this provider's three-retry cap before rotating on transient failures.
    const failureCount = params.exhaustTransientRetries ? 4 : 1;
    for (let attempt = 0; attempt < failureCount; attempt += 1) {
      runEmbeddedAttemptMock.mockResolvedValueOnce({
        ...(params.failureStage === "prompt"
          ? makeAttempt({
              terminal: { kind: "failed", source: "prompt", error: new Error(params.errorMessage) },
            })
          : makeErrorAttempt({ errorMessage: params.errorMessage })),
        providerRetryMaxRetries: 3,
      });
    }
    mockSingleSuccessfulAttempt();
    await runAutoPinnedOpenAiTurn({
      agentDir,
      workspaceDir,
      sessionKey: params.sessionKey,
      runId: params.runId,
      config: params.config,
    });

    expectAuthProfileAttempts(
      params.exhaustTransientRetries
        ? ["openai:p1", "openai:p1", "openai:p1", "openai:p1", "openai:p2"]
        : ["openai:p1", "openai:p2"],
    );
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(params.exhaustTransientRetries ? 3 : 0);
    const usageStats = await readUsageStats(agentDir);
    expect(usageStats["openai:p2"]?.lastUsed).toBeGreaterThan(2);
    return { usageStats };
  });
}

function mockSingleSuccessfulAttempt() {
  runEmbeddedAttemptMock.mockResolvedValueOnce(makeSuccessfulAttempt());
}

type TestWorkspace = {
  agentDir: string;
  workspaceDir: string;
  runTurn: (
    params: Omit<Parameters<typeof runEmbeddedAgentInline>[0], "agentDir" | "workspaceDir">,
  ) => ReturnType<typeof runEmbeddedAgentInline>;
};

async function withTimedAgentWorkspace<T>(
  run: (ctx: TestWorkspace & { now: number }) => Promise<T>,
) {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    return await withAgentWorkspace((ctx) => run({ ...ctx, now }));
  } finally {
    vi.useRealTimers();
  }
}

async function withAgentWorkspace<T>(run: (ctx: TestWorkspace) => Promise<T>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
  try {
    return await run({
      agentDir,
      workspaceDir,
      runTurn: (params) => runEmbeddedAgentInline({ agentDir, workspaceDir, ...params }),
    });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function requireLogRecord(
  records: ReadonlyArray<unknown>,
  message: string,
): Record<string, unknown> {
  const record = records.find(
    (candidate) => requireRecord(candidate, "log record").message === message,
  );
  if (!record) {
    throw new Error(`expected log record: ${message}`);
  }
  return requireRecord(record, message);
}

async function expectFailoverError(
  promise: Promise<unknown>,
  expected: {
    name?: string;
    profileId?: string;
    reason?: string;
    provider?: string;
    model?: string;
  },
) {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const errorRecord = requireRecord(thrown, "failover error");
  expect(errorRecord).toMatchObject({ name: "FailoverError", ...expected });
  return errorRecord;
}

async function runTurnWithCooldownSeed(params: {
  sessionKey: string;
  runId: string;
  authProfileId: string | undefined;
  authProfileIdSource: "auto" | "user";
}) {
  return await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
    await writeAuthStore(agentDir, {
      usageStats: {
        "openai:p1": { lastUsed: 1, cooldownUntil: now + 60 * 60 * 1000 },
        "openai:p2": { lastUsed: 2 },
      },
    });
    mockSingleSuccessfulAttempt();

    await runEmbeddedAgentInline({
      sessionKey: params.sessionKey,
      workspaceDir,
      agentDir,
      authProfileId: params.authProfileId,
      authProfileIdSource: params.authProfileIdSource,
      runId: params.runId,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    return { usageStats: await readUsageStats(agentDir), now };
  });
}

describe("runEmbeddedAgent auth profile rotation", () => {
  it("does not persist auth profile bookkeeping for read-only probes", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      await writeAuthStore(agentDir);
      const before = ensureAuthProfileStore(agentDir, { syncExternalCli: false });
      const expectedBookkeeping = structuredClone({
        lastGood: before.lastGood,
        usageStats: before.usageStats,
      });
      mockFailedThenSuccessfulAttempt(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      );

      await runTurn({
        authProfileId: "openai:p1",
        authProfileStateMode: "read-only",
        runId: "run:read-only-auth-profile-state",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      const after = ensureAuthProfileStore(agentDir, { syncExternalCli: false });
      expect({ lastGood: after.lastGood, usageStats: after.usageStats }).toEqual(
        expectedBookkeeping,
      );
    });
  });

  it("allows another auth refresh after a successful retry", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      await writeCopilotAuthStore(agentDir);
      const now = Date.now();

      // Avoid an immediate scheduled refresh racing the explicit auth retry.
      for (const [token, minutes] of [
        ["copilot-initial", 10],
        ["copilot-refresh-1", 10],
        ["copilot-refresh-2", 40],
      ] as const) {
        resolveCopilotApiTokenMock.mockResolvedValueOnce({
          token,
          expiresAt: now + minutes * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        });
      }

      const copilotError = (errorMessage: string) =>
        makeAttempt({
          assistantTexts: [],
          lastAssistant: buildAssistant({
            provider: "github-copilot",
            model: copilotModelId,
            stopReason: "error",
            errorMessage,
          }),
        });
      runEmbeddedAttemptMock
        .mockResolvedValueOnce(copilotError("401 unauthorized"))
        .mockResolvedValueOnce(
          makeAttempt({
            terminal: {
              kind: "failed",
              source: "prompt",
              error: new Error("Unsupported reasoning.effort; supported values are: low, medium"),
            },
          }),
        )
        .mockResolvedValueOnce(copilotError("token has expired"))
        .mockResolvedValueOnce(
          makeSuccessfulAttempt({ provider: "github-copilot", model: copilotModelId }),
        );

      await runTurn({
        config: makeCopilotConfig(),
        provider: "github-copilot",
        model: copilotModelId,
        runId: "run:copilot-auth-repeat",
      });
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(4);
      expect(resolveCopilotApiTokenMock).toHaveBeenCalledTimes(3);
    });
  });

  it("logs structured failover decision metadata for overloaded assistant rotation", async () => {
    const logCapture = createDiagnosticLogRecordCaptureFn();
    cleanupLogCapture = logCapture.cleanup;
    setLoggerOverrideFn({
      level: "trace",
      consoleLevel: "silent",
      file: path.join(os.tmpdir(), `openclaw-auth-rotation-${Date.now()}.log`),
    });

    const { usageStats } = await runAutoPinnedRotationCase({
      exhaustTransientRetries: true,
      errorMessage:
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_overload"}',
      sessionKey: "agent:test:overloaded-logging",
      runId: "run:overloaded-logging",
    });
    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(computeBackoffMock).not.toHaveBeenCalled();
    await logCapture.flush();

    const failoverDecision = requireLogRecord(logCapture.records, "embedded run failover decision");
    const failoverAttributes = requireRecord(
      failoverDecision.attributes,
      "failover decision attributes",
    );
    expect(failoverAttributes).toMatchObject({
      event: "embedded_run_failover_decision",
      runId: "run:overloaded-logging",
      decision: "rotate_profile",
      failoverReason: "overloaded",
      profileId: redactIdentifier("openai:p1", { len: 12 }),
      sourceProvider: "openai",
      sourceModel: "mock-1",
      providerErrorType: "overloaded_error",
      requestIdHash: redactIdentifier("req_overload", { len: 12 }),
    });
    expect(failoverAttributes).not.toHaveProperty("rawErrorPreview");

    expect(
      logCapture.records.some(
        (record) =>
          requireRecord(record, "log record").message === "auth profile failure state updated",
      ),
    ).toBe(false);
  });

  it("rotates for overloaded prompt failures across auto-pinned profiles", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      failureStage: "prompt",
      exhaustTransientRetries: true,
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      sessionKey: "agent:test:overloaded-prompt-rotation",
      runId: "run:overloaded-prompt-rotation",
    });
    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(computeBackoffMock).not.toHaveBeenCalled();
  });

  it("marks inline provider api key billing prompt failures without an auth profile", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      saveAuthProfileStore({ version: 1, profiles: {}, usageStats: {} }, agentDir);
      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          terminal: { kind: "failed", source: "prompt", error: new Error("insufficient credits") },
        }),
      );

      await expect(runTurn({ runId: "run:inline-api-key-prompt-billing" })).rejects.toThrow(
        /insufficient credits/,
      );

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      const usageStats = await readUsageStats(agentDir);
      const usageId = resolveInlineProviderApiKeyUsageId("openai");
      expect(usageStats[usageId]?.disabledReason).toBe("billing");
      expect(typeof usageStats[usageId]?.disabledUntil).toBe("number");
      expect(usageStats["openai:p1"]).toBeUndefined();
    });
  });

  it("rotates after provider-started timeouts and records the failed profile cooldown", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      exhaustTransientRetries: true,
      errorMessage: "request ended without sending any chunks",
      sessionKey: "agent:test:provider-timeout",
      runId: "run:provider-timeout",
    });
    const failedProfile = usageStats["openai:p1"];
    expect(failedProfile?.errorCount).toBe(1);
    expect(failedProfile?.failureCounts).toEqual({ timeout: 1 });
    expect(failedProfile?.cooldownReason).toBe("timeout");
    const lastFailureAt = failedProfile?.lastFailureAt;
    expect(lastFailureAt).toBeTypeOf("number");
    expect(failedProfile?.cooldownUntil).toBe(lastFailureAt! + 30_000);
    expect(computeBackoffMock).not.toHaveBeenCalled();
  });

  it("rotates on bare service unavailable without cooling down the profile", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      exhaustTransientRetries: true,
      errorMessage: "LLM error: service unavailable",
      sessionKey: "agent:test:service-unavailable-no-cooldown",
      runId: "run:service-unavailable-no-cooldown",
    });
    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
  });

  it("does not rotate for compaction timeouts", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      await writeAuthStore(agentDir);

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          ...makeSuccessfulAttempt({}, "partial"),
          terminal: { kind: "timeout", phase: "compaction", source: "runtime", aborted: true },
        }),
      );

      const result = await runTurn({ authProfileId: "openai:p1", runId: "run:compaction-timeout" });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.meta.aborted).toBe(false);

      expect((await readUsageStats(agentDir))["openai:p2"]?.lastUsed).toBe(2);
    });
  });

  it("does not rotate when failover-looking prompt errors came from compaction wait", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      await writeAuthStore(agentDir);

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          ...makeSuccessfulAttempt({}, "partial"),
          terminal: {
            kind: "failed",
            source: "compaction",
            error: new Error("rate limit exceeded"),
          },
        }),
      );

      const result = await runTurn({
        authProfileId: "openai:p1",
        runId: "run:compaction-wait-abort",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text).toContain("partial");
      expect((await readUsageStats(agentDir))["openai:p2"]?.lastUsed).toBe(2);
    });
  });

  it("rotates from a rate-limited user pin to the next same-provider profile", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      await writeAuthStore(agentDir);

      mockFailedThenSuccessfulAttempt("429 Too Many Requests: subscription usage limit reached");

      await runTurn({
        authProfileId: "openai:p1",
        authProfileIdSource: "user",
        runId: "run:user",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p1"]?.cooldownUntil).toBe("number");
      expect(usageStats["openai:p2"]?.lastUsed).not.toBe(2);
    });
  });

  it("skips a user-pinned profile while only that profile is in cooldown", async () => {
    const { usageStats, now } = await runTurnWithCooldownSeed({
      sessionKey: "agent:test:user-cooldown",
      runId: "run:user-cooldown",
      authProfileId: "openai:p1",
      authProfileIdSource: "user",
    });

    expect(usageStats["openai:p1"]?.cooldownUntil).toBe(now + 60 * 60 * 1000);
    expect(usageStats["openai:p1"]?.lastUsed).toBe(1);
    expect(usageStats["openai:p2"]?.lastUsed).not.toBe(2);
  });

  it("honors user-pinned profiles even when stored order excludes them", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      await writeAuthStore(agentDir, {
        order: { openai: ["openai:p1"] },
      });
      mockSingleSuccessfulAttempt();

      await runTurn({
        authProfileId: "openai:p2",
        authProfileIdSource: "user",
        runId: "run:user-order-excluded",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.lastUsed).toBe(1);
      expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
      expect(usageStats["openai:p2"]?.lastUsed).not.toBe(2);
    });
  });

  it("rotates a user-pinned profile inside the Codex harness", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      await writeOpenAiCodexAuthStore(agentDir, true);
      mockFailedThenSuccessfulAttempt("429 Too Many Requests: subscription usage limit reached", {
        provider: "codex-cli",
        model: "gpt-5.4",
      });

      await runTurn({
        provider: "codex-cli",
        model: "gpt-5.4",
        authProfileId: "openai:work",
        authProfileIdSource: "user",
        runId: "run:user-auth-alias-rotation",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      const firstAttempt = requireRecord(
        runEmbeddedAttemptMock.mock.calls.at(0)?.[0],
        "first Codex attempt params",
      );
      const secondAttempt = requireRecord(
        runEmbeddedAttemptMock.mock.calls.at(1)?.[0],
        "second Codex attempt params",
      );
      expect(firstAttempt.authProfileId).toBe("openai:work");
      expect(firstAttempt.authProfileIdSource).toBe("user");
      expect(secondAttempt.authProfileId).toBe("openai:backup");
      expect(secondAttempt.authProfileIdSource).toBe("auto");
    });
  });

  it("preserves a transient plugin-harness probe after a billing-disabled user pin", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, now, runTurn }) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:pinned": { type: "token", provider: "openai", token: "subscription-pinned" },
            "openai:backup": { type: "token", provider: "openai", token: "subscription-backup" },
          },
          order: { openai: ["openai:pinned", "openai:backup"] },
          usageStats: {
            "openai:pinned": { disabledUntil: now + 60 * 60 * 1000, disabledReason: "billing" },
            "openai:backup": {
              cooldownUntil: now + 60 * 60 * 1000,
              failureCounts: { rate_limit: 1 },
            },
          },
        },
        agentDir,
      );
      const harness: AgentHarness = {
        id: "probe-harness",
        label: "Probe harness",
        authBootstrap: "harness",
        supports: (ctx) =>
          ctx.requestedRuntime === "probe-harness"
            ? { supported: true, priority: 100 }
            : { supported: false, reason: "test harness requires an explicit runtime" },
        runAttempt: async (attemptParams) => await runEmbeddedAttemptMock(attemptParams),
      };
      registerAgentHarnessFn(harness);
      mockSingleSuccessfulAttempt();

      await runTurn({
        model: "chatgpt-mock",
        agentHarnessId: "probe-harness",
        authProfileId: "openai:pinned",
        authProfileIdSource: "user",
        allowTransientCooldownProbe: true,
        runId: "run:plugin-harness-mixed-cooldown",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledOnce();
      const attemptParams = requireRecord(
        runEmbeddedAttemptMock.mock.calls[0]?.[0],
        "plugin harness attempt params",
      );
      expect(attemptParams.authProfileId).toBe("openai:backup");
      expect(attemptParams.authProfileIdSource).toBe("auto");
    });
  });

  it("ignores a user-pinned profile when the provider mismatches", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      await writeAuthStore(agentDir, { includeAnthropic: true });

      mockSingleSuccessfulAttempt();

      await runTurn({
        authProfileId: "anthropic:default",
        authProfileIdSource: "user",
        runId: "run:mismatch",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    });
  });

  it("skips profiles in cooldown during initial selection", async () => {
    const { usageStats, now } = await runTurnWithCooldownSeed({
      sessionKey: "agent:test:skip-cooldown",
      runId: "run:skip-cooldown",
      authProfileId: undefined,
      authProfileIdSource: "auto",
    });

    expect(usageStats["openai:p1"]?.cooldownUntil).toBe(now + 60 * 60 * 1000);
    expectAuthProfileAttempts(["openai:p2"]);
    expect(usageStats["openai:p2"]?.lastUsed).toBeGreaterThan(2);
  });

  it("can probe one cooldowned profile when transient cooldown probe is explicitly allowed", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, now, runTurn }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": { lastUsed: 1, cooldownUntil: now + 60 * 60 * 1000 },
          "openai:p2": { lastUsed: 2, cooldownUntil: now + 60 * 60 * 1000 },
        },
      });

      mockSingleSuccessfulAttempt();

      const result = await runTurn({
        config: makeConfig({ fallbacks: ["openai/mock-2"] }),
        allowTransientCooldownProbe: true,
        runId: "run:cooldown-probe",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");
    });
  });

  it("does not spend a transient cooldown probe on billing-disabled profiles", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, now, runTurn }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": {
            lastUsed: 1,
            disabledUntil: now + 60 * 60 * 1000,
            disabledReason: "billing",
          },
          "openai:p2": {
            lastUsed: 2,
            disabledUntil: now + 60 * 60 * 1000,
            disabledReason: "billing",
          },
        },
      });

      await expect(
        runTurn({
          allowTransientCooldownProbe: true,
          runId: "run:billing-cooldown-probe-no-fallbacks",
        }),
      ).rejects.toThrow("billing issue");

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("treats agent-level fallbacks as configured when defaults have none", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, now, runTurn }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": { lastUsed: 1, cooldownUntil: now + 60 * 60 * 1000 },
          "openai:p2": { lastUsed: 2, cooldownUntil: now + 60 * 60 * 1000 },
        },
      });

      await expectFailoverError(
        runTurn({
          sessionKey: "agent:support:cooldown-failover",
          config: makeAgentOverrideOnlyFallbackConfig("support"),
          runId: "run:agent-override-fallback",
          agentId: "support",
        }),
        { reason: "unknown", provider: "openai", model: "mock-1" },
      );

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("fails over with disabled reason when all profiles are unavailable", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, now, runTurn }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": {
            lastUsed: 1,
            disabledUntil: now + 60 * 60 * 1000,
            disabledReason: "billing",
            failureCounts: { rate_limit: 4 },
          },
          "openai:p2": {
            lastUsed: 2,
            disabledUntil: now + 60 * 60 * 1000,
            disabledReason: "billing",
          },
        },
      });

      await expectFailoverError(
        runTurn({
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          runId: "run:disabled-failover",
        }),
        { reason: "billing", provider: "openai", model: "mock-1" },
      );

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("fails over when auth is unavailable and fallbacks are configured", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await withAgentWorkspace(async ({ agentDir, runTurn }) => {
        saveAuthProfileStore({ version: 1, profiles: {}, usageStats: {} }, agentDir);

        await expectFailoverError(
          runTurn({
            config: makeConfig({ fallbacks: ["openai/mock-2"], apiKey: "" }),
            runId: "run:auth-unavailable",
          }),
          { reason: "auth" },
        );

        expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
      });
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });

  it("uses the active erroring model in billing failover errors", async () => {
    await withAgentWorkspace(async ({ agentDir, runTurn }) => {
      await writeAuthStore(agentDir);
      runEmbeddedAttemptMock.mockResolvedValue(
        makeErrorAttempt(
          { errorMessage: "insufficient credits", provider: "openai", model: "mock-rotated" },
          { currentAttempt: true },
        ),
      );

      const errorRecord = await expectFailoverError(
        runTurn({
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          authProfileId: "openai:p1",
          authProfileIdSource: "user",
          runId: "run:billing-failover-active-model",
        }),
        { reason: "billing", provider: "openai", model: "mock-rotated" },
      );
      expect(errorRecord.message).toContain("openai (mock-rotated) returned a billing error");
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    });
  });

  it("skips profiles in cooldown when rotating after failure", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      const p2CooldownUntil = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:p1": { type: "api_key", provider: "openai", key: "sk-one" },
            "openai:p2": { type: "api_key", provider: "openai", key: "sk-two" },
            "openai:p3": { type: "api_key", provider: "openai", key: "sk-three" },
          },
          usageStats: {
            "openai:p1": { lastUsed: 1 },
            "openai:p2": { cooldownUntil: p2CooldownUntil },
            "openai:p3": { lastUsed: 3 },
          },
        },
        agentDir,
      );

      mockFailedThenSuccessfulAttempt("429 Too Many Requests: subscription usage limit reached");
      await runAutoPinnedOpenAiTurn({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:rotate-skip-cooldown",
        runId: "run:rotate-skip-cooldown",
      });

      expectAuthProfileAttempts(["openai:p1", "openai:p3"]);
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p1"]?.lastUsed).toBe("number");
      expect(usageStats["openai:p3"]?.lastUsed).toBeGreaterThan(3);
      expect(usageStats["openai:p2"]?.cooldownUntil).toBe(p2CooldownUntil);
    });
  });
  it("runs an agent-scoped session without an ambient default owner", async () => {
    await withAgentWorkspace(async ({ runTurn }) => {
      mockSingleSuccessfulAttempt();

      await runTurn({
        sessionId: "session:work",
        sessionKey: "agent:work:dashboard:scoped-run",
        config: {
          ...makeConfig(),
          agents: { entries: { main: {}, work: {} } },
        },
        authProfileId: "openai:p1",
        runId: "run:work",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
