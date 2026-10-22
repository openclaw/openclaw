import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
// End-to-end auth-profile rotation coverage for embedded runner retries.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { resolveInlineProviderApiKeyUsageId } from "./auth-profiles.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { installScriptedRunnerMocks } from "./embedded-agent-runner.mock-test-support.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import { model as modelDefinition } from "./model-catalog-fixtures.test-support.js";
import {
  buildEmbeddedRunnerAssistant as buildAssistant,
  makeEmbeddedRunnerAttempt as makeAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

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
  installScriptedRunnerMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
    modelsConfig: "mock",
    backoff: {
      computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
      sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
    },
    prepareProviderRuntimeAuth: async (params) => {
      if (params.provider !== "github-copilot") {
        return undefined;
      }
      const token = await resolveCopilotApiTokenMock(params.context.apiKey);
      return { apiKey: token.token, baseUrl: token.baseUrl, expiresAt: token.expiresAt };
    },
    resolveModel: async (provider, modelId) => {
      return {
        logicalRef: { provider, model: modelId },
        model: {
          ...makeModel(modelId, modelId),
          api: "openai-responses",
          provider,
          baseUrl:
            provider === "github-copilot" ? "https://api.copilot.example" : "https://example.com",
        },
        error: undefined,
        authStorage: { setRuntimeApiKey: vi.fn() },
        modelRegistry: {},
      };
    },
  });
  vi.doMock("./embedded-agent-runner/compact.js", () => ({
    compactEmbeddedAgentSessionDirect: vi.fn(async () => {
      throw new Error("compact should not run in auth profile rotation tests");
    }),
  }));
};

let runtime: Awaited<ReturnType<typeof loadRuntime>>;
let agentDir: string;
let workspaceDir: string;
const originalFetch = globalThis.fetch;

async function loadRuntime() {
  vi.resetModules();
  installRunEmbeddedMocks();
  return {
    config: await import("../config/config.js"),
    run: wrapRunWithTestPreparedAdmission(
      (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
    ),
    // Fixture reads and runner writes share the post-reset auth snapshot owner.
    auth: await import("./auth-profiles/store-runtime.js"),
    maintenance: (await import("../state/openclaw-state-db-async-lifecycle.js"))
      .createOpenClawDatabaseMaintenanceScope,
  };
}
beforeAll(async () => {
  runtime = await loadRuntime();
});

type RunEmbeddedAgentTestParams = Parameters<typeof runtime.run>[0] & {
  authProfileStateMode?: "read-write" | "read-only";
};

async function runTurn(
  params: Pick<RunEmbeddedAgentTestParams, "runId"> & Partial<RunEmbeddedAgentTestParams>,
): Promise<Awaited<ReturnType<typeof runtime.run>>> {
  const maintenance = runtime.maintenance();
  try {
    return await maintenance.run(() =>
      runtime.run({
        agentDir,
        workspaceDir,
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

beforeEach(async () => {
  runtime.config.setRuntimeConfigSnapshot({});
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
  agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
});

afterEach(async () => {
  vi.useRealTimers();
  try {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  } finally {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  }
});

const makeModel = (id: string, name: string) =>
  modelDefinition(id, name, { contextWindow: 16_000, maxTokens: 2048 });

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
  storageDir: string,
  opts?: Pick<Parameters<typeof runtime.auth.saveAuthProfileStore>[0], "order" | "usageStats"> & {
    profiles?: Parameters<typeof runtime.auth.saveAuthProfileStore>[0]["profiles"];
  },
) => {
  // Store order and usageStats are the persisted inputs the rotation picker
  // uses to decide which profile should be cooled down or retried.
  runtime.auth.saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openai:p1": { type: "api_key", provider: "openai", key: "sk-one" },
        "openai:p2": { type: "api_key", provider: "openai", key: "sk-two" },
        ...opts?.profiles,
      },
      ...(opts?.order ? { order: opts.order } : {}),
      usageStats: opts?.usageStats ?? {
        "openai:p1": { lastUsed: 1 },
        "openai:p2": { lastUsed: 2 },
      },
    },
    storageDir,
  );
};

const writeCopilotAuthStore = async (storageDir: string, token = "gh-token") => {
  runtime.auth.saveAuthProfileStore(
    createAuthProfileStoreFixture({
      "github-copilot:github": { type: "token", provider: "github-copilot", token },
    }),
    storageDir,
  );
};

const writeOpenAiCodexAuthStore = async (storageDir: string, includeBackup = false) => {
  runtime.auth.saveAuthProfileStore(
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
    storageDir,
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

async function readUsageStats(storageDir: string) {
  return (
    runtime.auth.ensureAuthProfileStore(storageDir, { syncExternalCli: false }).usageStats ?? {}
  );
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
  await runTurn({
    sessionKey: params.sessionKey,
    runId: params.runId,
    config: params.config ?? makeConfig(),
    authProfileId: "openai:p1",
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
}

function mockSingleSuccessfulAttempt() {
  runEmbeddedAttemptMock.mockResolvedValueOnce(makeSuccessfulAttempt());
}

function freezeTime() {
  vi.useFakeTimers();
  const now = Date.now();
  vi.setSystemTime(now);
  return now;
}

const requireRecord = createRequireRecord("record", "expected-label-record");

async function expectFailoverError(promise: Promise<unknown>, expected: Record<string, unknown>) {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(Error);
  const errorRecord = requireRecord(thrown, "failover error");
  expect(errorRecord).toMatchObject({ name: "FailoverError", ...expected });
  return errorRecord;
}

describe("runEmbeddedAgent auth profile rotation", () => {
  it("does not persist auth profile bookkeeping for read-only probes", async () => {
    await writeAuthStore(agentDir);
    const before = runtime.auth.ensureAuthProfileStore(agentDir, { syncExternalCli: false });
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
    const after = runtime.auth.ensureAuthProfileStore(agentDir, { syncExternalCli: false });
    expect({ lastGood: after.lastGood, usageStats: after.usageStats }).toEqual(expectedBookkeeping);
  });

  it("allows another auth refresh after a successful retry", async () => {
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
    runtime.auth.saveAuthProfileStore({ version: 1, profiles: {}, usageStats: {} }, agentDir);
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

  it("rotates after provider-started timeouts and records the failed profile cooldown", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      exhaustTransientRetries: true,
      errorMessage: "request ended without sending any chunks",
      sessionKey: "agent:test:provider-timeout",
      runId: "run:provider-timeout",
    });
    const failedProfile = usageStats["openai:p1"];
    expect(failedProfile).toMatchObject({ errorCount: 1, cooldownReason: "timeout" });
    expect(failedProfile?.failureCounts).toEqual({ timeout: 1 });
    const lastFailureAt = failedProfile?.lastFailureAt;
    expect(lastFailureAt).toBeTypeOf("number");
    expect(failedProfile?.cooldownUntil).toBe(lastFailureAt! + 30_000);
    expect(computeBackoffMock).not.toHaveBeenCalled();
  });

  it.each(["timeout", "rate limit"] as const)("does not rotate for compaction %s", async (kind) => {
    await writeAuthStore(agentDir);
    const terminal: EmbeddedRunAttemptResult["terminal"] =
      kind === "timeout"
        ? { kind: "timeout", phase: "compaction", source: "runtime", aborted: true }
        : { kind: "failed", source: "compaction", error: new Error("rate limit exceeded") };
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeAttempt({ ...makeSuccessfulAttempt({}, "partial"), terminal }),
    );
    const result = await runTurn({ authProfileId: "openai:p1", runId: `run:compaction-${kind}` });
    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    if (kind === "timeout") {
      expect(result.meta.aborted).toBe(false);
    } else {
      expect(result.payloads?.[0]?.text).toContain("partial");
    }
    expect((await readUsageStats(agentDir))["openai:p2"]?.lastUsed).toBe(2);
  });

  it("rotates from a rate-limited user pin to the next same-provider profile", async () => {
    await writeAuthStore(agentDir);

    mockFailedThenSuccessfulAttempt("429 Too Many Requests: subscription usage limit reached");

    await runTurn({
      authProfileId: "openai:p1",
      authProfileIdSource: "user",
      runId: "run:user",
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    const usageStats = await readUsageStats(agentDir);
    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(usageStats["openai:p2"]?.lastUsed).not.toBe(2);
  });

  it.each(["user cooldown", "auto cooldown", "user excluded"] as const)(
    "selects an available profile for %s",
    async (selection) => {
      const cooldown = selection !== "user excluded";
      const automatic = selection === "auto cooldown";
      const now = cooldown ? freezeTime() : Date.now();
      await writeAuthStore(
        agentDir,
        cooldown
          ? {
              usageStats: {
                "openai:p1": { lastUsed: 1, cooldownUntil: now + 3_600_000 },
                "openai:p2": { lastUsed: 2 },
              },
            }
          : { order: { openai: ["openai:p1"] } },
      );
      mockSingleSuccessfulAttempt();
      await runTurn({
        runId: `run:${selection.replaceAll(" ", "-")}`,
        authProfileId: automatic ? undefined : cooldown ? "openai:p1" : "openai:p2",
        authProfileIdSource: automatic ? "auto" : "user",
      });
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      const usageStats = await readUsageStats(agentDir);
      if (cooldown) {
        expect(usageStats["openai:p1"]?.cooldownUntil).toBe(now + 3_600_000);
      }
      if (automatic) {
        expectAuthProfileAttempts(["openai:p2"]);
        expect(usageStats["openai:p2"]?.lastUsed).toBeGreaterThan(2);
      } else {
        expect(usageStats["openai:p1"]?.lastUsed).toBe(1);
        expect(usageStats["openai:p2"]?.lastUsed).not.toBe(2);
        if (!cooldown) {
          expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
        }
      }
    },
  );

  it("rotates a user-pinned profile inside the Codex harness", async () => {
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
    expect(runEmbeddedAttemptMock.mock.calls.map(([params]) => params)).toMatchObject([
      { authProfileId: "openai:work", authProfileIdSource: "user" },
      { authProfileId: "openai:backup", authProfileIdSource: "auto" },
    ]);
  });

  it("treats agent-level fallbacks as configured when defaults have none", async () => {
    const cooldownUntil = freezeTime() + 3_600_000;
    await writeAuthStore(agentDir, {
      usageStats: {
        "openai:p1": { lastUsed: 1, cooldownUntil },
        "openai:p2": { lastUsed: 2, cooldownUntil },
      },
    });
    await expectFailoverError(
      runTurn({
        runId: "run:agent-override-fallback",
        agentId: "support",
        sessionKey: "agent:support:cooldown-failover",
        config: makeAgentOverrideOnlyFallbackConfig("support"),
      }),
      { reason: "unknown", provider: "openai", model: "mock-1" },
    );
    expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "transient probe", billing: false, probe: true },
    { name: "billing blocks probe", billing: true, probe: true },
    { name: "billing failover", billing: true, probe: false },
  ])("handles unavailable profiles: $name", async ({ name, billing, probe }) => {
    const unavailableUntil = freezeTime() + 3_600_000;
    const unavailable = billing
      ? { disabledUntil: unavailableUntil, disabledReason: "billing" as const }
      : { cooldownUntil: unavailableUntil };
    await writeAuthStore(agentDir, {
      usageStats: {
        "openai:p1": {
          lastUsed: 1,
          ...unavailable,
          ...(billing && !probe ? { failureCounts: { billing: 4 } } : {}),
        },
        "openai:p2": { lastUsed: 2, ...unavailable },
      },
    });
    if (!billing) {
      mockSingleSuccessfulAttempt();
    }
    const turn = runTurn({
      runId: `run:${name.replaceAll(" ", "-")}`,
      config: makeConfig({ fallbacks: billing && probe ? [] : ["openai/mock-2"] }),
      ...(probe ? { allowTransientCooldownProbe: true } : {}),
    });
    if (!billing) {
      expect((await turn).payloads?.[0]?.text ?? "").toContain("ok");
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    } else {
      if (probe) {
        await expect(turn).rejects.toThrow("billing issue");
      } else {
        await expectFailoverError(turn, { reason: "billing", provider: "openai", model: "mock-1" });
      }
      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    }
  });

  it("fails over when auth is unavailable and fallbacks are configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    runtime.auth.saveAuthProfileStore({ version: 1, profiles: {}, usageStats: {} }, agentDir);

    await expectFailoverError(
      runTurn({
        config: makeConfig({ fallbacks: ["openai/mock-2"], apiKey: "" }),
        runId: "run:auth-unavailable",
      }),
      { reason: "auth" },
    );

    expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
  });

  it("uses the active erroring model in billing failover errors", async () => {
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

  it("skips profiles in cooldown when rotating after failure", async () => {
    const p2CooldownUntil = Date.now() + 60 * 60 * 1000;
    await writeAuthStore(agentDir, {
      profiles: { "openai:p3": { type: "api_key", provider: "openai", key: "sk-three" } },
      usageStats: {
        "openai:p1": { lastUsed: 1 },
        "openai:p2": { cooldownUntil: p2CooldownUntil },
        "openai:p3": { lastUsed: 3 },
      },
    });

    mockFailedThenSuccessfulAttempt("429 Too Many Requests: subscription usage limit reached");
    await runTurn({
      sessionKey: "agent:test:rotate-skip-cooldown",
      runId: "run:rotate-skip-cooldown",
      authProfileId: "openai:p1",
    });

    expectAuthProfileAttempts(["openai:p1", "openai:p3"]);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
    const usageStats = await readUsageStats(agentDir);
    expect(typeof usageStats["openai:p1"]?.lastUsed).toBe("number");
    expect(usageStats["openai:p3"]?.lastUsed).toBeGreaterThan(3);
    expect(usageStats["openai:p2"]?.cooldownUntil).toBe(p2CooldownUntil);
  });
});
