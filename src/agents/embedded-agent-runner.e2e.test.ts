// End-to-end embedded-agent runner tests with mocked model/runtime seams.
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import { installScriptedRunnerMocks } from "./embedded-agent-runner.mock-test-support.js";
import { model as catalogModel } from "./model-catalog-fixtures.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  cleanupEmbeddedAgentRunnerTestWorkspace,
  createEmbeddedAgentRunnerOpenAiConfig as createBaseEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
  createEmbeddedAgentRunnerTestWorkspace,
  type EmbeddedAgentRunnerTestWorkspace,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const runEmbeddedAttemptMock = vi.fn();
const preparedPluginRegistry = createEmptyPluginRegistry();
const disposeSessionMcpRuntimeMock = vi.fn<(sessionId: string) => Promise<void>>(
  async () => undefined,
);
const resolveSessionKeyForRequestMock = vi.fn();
const resolveStoredSessionKeyForSessionIdMock = vi.fn();
const resolveModelAsyncMock = vi.fn(async (provider: string, modelId: string) =>
  createResolvedEmbeddedRunnerModel(provider, modelId),
);
const ensureOpenClawModelsJsonMock = vi.fn(async () => ({ wrote: false }));
const loggerWarnMock = vi.fn();
let refreshRuntimeAuthOnFirstPromptError = false;
let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;

// Fast harness attempts own responses; reaching provider inference is a fixture bug.
vi.mock("openclaw/plugin-sdk/llm", async () => {
  const unexpectedInference = () => {
    throw new Error("Unexpected provider inference outside the mocked embedded attempt");
  };
  return {
    ...(await vi.importActual<typeof import("openclaw/plugin-sdk/llm")>("openclaw/plugin-sdk/llm")),
    complete: unexpectedInference,
    completeSimple: unexpectedInference,
    streamSimple: unexpectedInference,
  };
});

const installRunEmbeddedMocks = () => {
  // Install only the runtime seams needed by runner orchestration so tests avoid
  // loading real providers, MCP runtimes, or gateway side effects.
  installScriptedRunnerMocks({
    hookRunner: "full",
    pluginRegistry: preparedPluginRegistry,
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
    resolveModel: false,
  });
  vi.doMock("./command/session.js", async () => {
    const actual =
      await vi.importActual<typeof import("./command/session.js")>("./command/session.js");
    return {
      ...actual,
      resolveSessionKeyForRequestCore: (opts: unknown) => resolveSessionKeyForRequestMock(opts),
      resolveStoredSessionKeyForSessionId: (opts: unknown) =>
        resolveStoredSessionKeyForSessionIdMock(opts),
    };
  });
  vi.doMock("./embedded-agent-runner/logger.js", async () => {
    const actual = await vi.importActual<typeof import("./embedded-agent-runner/logger.js")>(
      "./embedded-agent-runner/logger.js",
    );
    return {
      ...actual,
      log: {
        ...actual.log,
        warn: (...args: unknown[]) => loggerWarnMock(...args),
      },
    };
  });
  vi.doMock("./agent-bundle-mcp-tools.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./agent-bundle-mcp-tools.js")>()),
    disposeSessionMcpRuntime: (sessionId: string) => disposeSessionMcpRuntimeMock(sessionId),
    retireSessionMcpRuntime: ({ sessionId }: { sessionId?: string | null }) =>
      sessionId ? disposeSessionMcpRuntimeMock(sessionId) : Promise.resolve(false),
  }));
  vi.doMock("./embedded-agent-runner/model.js", async () => {
    const actual = await vi.importActual<typeof import("./embedded-agent-runner/model.js")>(
      "./embedded-agent-runner/model.js",
    );
    return {
      ...actual,
      resolveModelAsync: (...args: Parameters<typeof resolveModelAsyncMock>) =>
        resolveModelAsyncMock(...args),
    };
  });
  vi.doMock("./embedded-agent-runner/run/auth-controller.js", async () => {
    const actual = await vi.importActual<
      typeof import("./embedded-agent-runner/run/auth-controller.js")
    >("./embedded-agent-runner/run/auth-controller.js");
    return {
      ...actual,
      createEmbeddedRunAuthController: () => ({
        advanceAuthProfile: vi.fn(async () => false),
        initializeAuthProfile: vi.fn(async () => undefined),
        maybeRefreshRuntimeAuthForAuthError: vi.fn(async (_errorText: string, runtimeAuthRetry) => {
          return refreshRuntimeAuthOnFirstPromptError && runtimeAuthRetry !== true;
        }),
        stopRuntimeAuthRefreshTimer: vi.fn(),
      }),
    };
  });
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: (...args: Parameters<typeof ensureOpenClawModelsJsonMock>) =>
      ensureOpenClawModelsJsonMock(...args),
  }));
};

type ProductionRunEmbeddedAgent = typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
type TestRunEmbeddedAgent = (
  params: Omit<Parameters<ProductionRunEmbeddedAgent>[0], "admittedRunContext">,
) => ReturnType<ProductionRunEmbeddedAgent>;
let runEmbeddedAgent: TestRunEmbeddedAgent;
let upsertSessionEntryCore: typeof import("../config/sessions/session-accessor.js").upsertSessionEntryCore;
let resolveAgentRunSessionTarget: typeof import("./run-session-target.js").resolveAgentRunSessionTarget;
let e2eWorkspace: EmbeddedAgentRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;
let sessionStorePath: string;
let sessionCounter = 0;
let runCounter = 0;

const createEmbeddedAgentRunnerOpenAiConfig = (modelIds: string[]) => {
  const config = createBaseEmbeddedAgentRunnerOpenAiConfig(modelIds);
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.sessionStore = { agentId: "main" };
  config.session = { store: sessionStorePath };
  return config;
};

beforeAll(async () => {
  vi.useRealTimers();
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ setRuntimeConfigSnapshot } = await import("../config/config.js"));
  runEmbeddedAgent = wrapRunWithTestPreparedAdmission(
    (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
  );
  e2eWorkspace = await createEmbeddedAgentRunnerTestWorkspace("openclaw-embedded-agent-");
  ({ upsertSessionEntryCore } = await import("../config/sessions/session-accessor.js"));
  ({ resolveAgentRunSessionTarget } = await import("./run-session-target.js"));
  ({ agentDir, workspaceDir } = e2eWorkspace);
  sessionStorePath = path.join(e2eWorkspace.tempRoot, "sessions.json");
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedAgentRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

beforeEach(() => {
  preparedPluginRegistry.agentHarnesses.length = 0;
  setRuntimeConfigSnapshot({});
  vi.useRealTimers();
  runEmbeddedAttemptMock.mockReset();
  disposeSessionMcpRuntimeMock.mockReset();
  resolveSessionKeyForRequestMock.mockReset();
  resolveStoredSessionKeyForSessionIdMock.mockReset();
  resolveModelAsyncMock.mockReset();
  resolveModelAsyncMock.mockImplementation(async (provider: string, modelId: string) =>
    createResolvedEmbeddedRunnerModel(provider, modelId),
  );
  ensureOpenClawModelsJsonMock.mockReset();
  ensureOpenClawModelsJsonMock.mockResolvedValue({ wrote: false });
  loggerWarnMock.mockReset();
  refreshRuntimeAuthOnFirstPromptError = false;
  runEmbeddedAttemptMock.mockImplementation(async () => {
    throw new Error("unexpected extra runEmbeddedAttempt call");
  });
});

const nextSessionCompatibilityKey = () => `in-memory:embedded-compat-${++sessionCounter}`;
const nextRunId = (prefix = "run-embedded-test") => `${prefix}-${++runCounter}`;
const nextSessionKey = () => `agent:test:embedded:${nextRunId("session-key")}`;

const resolveTestSessionTarget = async (params: {
  config?: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>;
  sessionId: string;
  sessionKey: string;
}) =>
  await resolveAgentRunSessionTarget({
    config: params.config,
    missingSessionKey: "create",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });

async function createNativeSessionFixture(
  config: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>,
  sessionId: string,
) {
  const target = await resolveTestSessionTarget({
    config,
    sessionId,
    sessionKey: nextSessionKey(),
  });
  await upsertSessionEntryCore(
    { agentId: target.agentId, sessionKey: target.sessionKey, storePath: target.storePath },
    { sessionId, updatedAt: Date.now(), agentHarnessId: "codex", modelSelectionLocked: true },
  );
  preparedPluginRegistry.agentHarnesses.push({
    pluginId: "codex",
    source: "runtime",
    harness: {
      id: "codex",
      label: "Native Codex fixture",
      authBootstrap: "harness",
      supports: () => ({ supported: true }),
      resolveSessionRuntimeOwnership: ({ assertCurrent }) => {
        assertCurrent();
        return { model: "native", auth: "native" };
      },
      runAttempt: vi.fn(),
    },
  });
  return { sessionId, sessionKey: target.sessionKey };
}
const addAnthropicProvider = (
  cfg: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>,
  modelIds: string[],
) => ({
  ...cfg,
  models: {
    providers: {
      ...cfg.models?.providers,
      anthropic: {
        api: "anthropic-messages" as const,
        apiKey: "sk-test",
        baseUrl: "https://example.com",
        models: modelIds.map((id) =>
          catalogModel(id, `Mock ${id}`, { contextWindow: 16_000, maxTokens: 2048 }),
        ),
      },
    },
  },
});

const successfulAttempt = (overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {}) =>
  makeEmbeddedRunnerAttempt({
    assistantTexts: ["ok"],
    lastAssistant: buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  });

const mockSuccessfulEmbeddedAttempt = () =>
  runEmbeddedAttemptMock.mockResolvedValueOnce(successfulAttempt());

function firstRunEmbeddedAttemptParams() {
  const call = runEmbeddedAttemptMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected embedded attempt to be called");
  }
  return call[0] as Parameters<
    typeof import("./embedded-agent-runner/run/attempt.js").runEmbeddedAttempt
  >[0];
}

const runTestAgent = (params: Partial<Parameters<TestRunEmbeddedAgent>[0]>) =>
  runEmbeddedAgent({
    sessionId: "session:test",
    sessionFile: params.sessionFile ?? nextSessionCompatibilityKey(),
    workspaceDir,
    prompt: "hello",
    timeoutMs: 5_000,
    agentDir,
    runId: params.runId ?? nextRunId(),
    enqueue: immediateEnqueue,
    ...params,
  });

const runOpenAi = (
  params: Partial<Parameters<TestRunEmbeddedAgent>[0]>,
  config = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]),
) => runTestAgent({ config, provider: "openai", model: "mock-1", ...params });

async function runNativeSession(
  sessionId: string,
  params: Partial<Parameters<TestRunEmbeddedAgent>[0]> = {},
) {
  const config = createEmbeddedAgentRunnerOpenAiConfig([]);
  return runTestAgent({
    ...(await createNativeSessionFixture(config, sessionId)),
    config,
    provider: "anthropic",
    model: "retired-outer-model",
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    ...params,
  });
}

describe("runEmbeddedAgent", () => {
  it("uses runtime config for blank public runtime model overrides", async () => {
    const cfg = createEmbeddedAgentRunnerOpenAiConfig([]);
    cfg.agents!.defaults!.model = { primary: "openrouter/runtime-default" };
    setRuntimeConfigSnapshot(cfg);
    mockSuccessfulEmbeddedAttempt();

    await runTestAgent({
      sessionId: "runtime-config-default-model",
      provider: " ",
      model: "",
    });

    expect(firstRunEmbeddedAttemptParams().model).toMatchObject({
      provider: "openrouter",
      id: "openrouter/runtime-default",
    });
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "openrouter",
      "openrouter/runtime-default",
      agentDir,
      cfg,
      expect.objectContaining({ skipAgentDiscovery: true }),
    );
  });

  it("uses the session-key agent default when agentId is inferred", async () => {
    const cfg = {
      ...addAnthropicProvider(createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]), [
        "claude-opus-4-7",
      ]),
      agents: {
        defaults: {
          model: { primary: "openai/mock-1" },
        },
        entries: { research: { model: { primary: "anthropic/claude-opus-4-7" } } },
      },
    };
    mockSuccessfulEmbeddedAttempt();

    await runTestAgent({
      sessionId: "session-key-agent-default",
      sessionKey: "agent:research:embedded:session-key-agent-default",
      config: cfg,
    });

    expect(firstRunEmbeddedAttemptParams().model).toMatchObject({
      provider: "anthropic",
      id: "claude-opus-4-7",
    });
  });

  it("resolves model-only provider refs instead of prefixing the default provider", async () => {
    const cfg = addAnthropicProvider(createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]), [
      "claude-sonnet-4-6",
    ]);
    mockSuccessfulEmbeddedAttempt();

    await runTestAgent({
      sessionId: "model-only-provider-ref",
      config: cfg,
      model: "anthropic/claude-sonnet-4-6",
    });

    expect(firstRunEmbeddedAttemptParams().model).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });
  });

  it.each([
    {
      label: "trims the resolved key",
      sessionId: "resume-123",
      resolved: "agent:test:resolved",
      expected: "agent:test:resolved",
    },
    {
      label: "canonicalizes the unresolved fallback",
      sessionId: "resume-124",
      resolved: undefined,
      expected: "agent:main:resume-124",
    },
  ])(
    "backfills a whitespace-only session key: $label",
    async ({ sessionId, resolved, expected }) => {
      const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
      resolveSessionKeyForRequestMock.mockReturnValue({
        sessionKey: resolved,
        sessionStore: {},
        storePath: "/tmp/session-store.json",
      });
      mockSuccessfulEmbeddedAttempt();
      await runOpenAi(
        {
          sessionId,
          sessionKey: "   ",
          ...(resolved === undefined ? { sessionFile: sessionId } : {}),
        },
        cfg,
      );
      expect(resolveSessionKeyForRequestMock).toHaveBeenCalledWith({
        cfg,
        sessionId,
        agentId: undefined,
      });
      expect(firstRunEmbeddedAttemptParams().sessionKey).toBe(expected);
    },
  );

  it("logs when embedded session-key backfill resolution fails", async () => {
    resolveSessionKeyForRequestMock.mockImplementation(() => {
      throw new Error("resolver exploded");
    });
    mockSuccessfulEmbeddedAttempt();

    await runOpenAi({ sessionId: "resume-456" });

    expect(
      loggerWarnMock.mock.calls.some(([message]) =>
        String(message ?? "").includes("[backfillSessionIdentity] Failed to resolve sessionKey"),
      ),
    ).toBe(true);
  });

  it("passes the current agentId when backfilling a session key", async () => {
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveStoredSessionKeyForSessionIdMock.mockReturnValue({
      sessionKey: "agent:embedded-agent:resolved",
      sessionStore: {},
      storePath: "/tmp/session-store.json",
    });
    mockSuccessfulEmbeddedAttempt();

    await runOpenAi(
      {
        sessionId: "resume-agent-1",
        sessionKey: undefined,
        agentId: "embedded-agent",
      },
      cfg,
    );

    expect(resolveStoredSessionKeyForSessionIdMock).toHaveBeenCalledWith({
      cfg,
      sessionId: "resume-agent-1",
      agentId: "embedded-agent",
    });
    expect(resolveSessionKeyForRequestMock).not.toHaveBeenCalled();
  });

  it("lets a locked Codex harness own stale model resolution and context policy", async () => {
    const prompt = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
    resolveModelAsyncMock.mockRejectedValueOnce(new Error("stale outer model must not resolve"));
    mockSuccessfulEmbeddedAttempt();

    await runNativeSession("locked-codex-native-policy", { prompt });

    expect(resolveModelAsyncMock).not.toHaveBeenCalled();
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
    const attempt = firstRunEmbeddedAttemptParams();
    expect(attempt).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      provider: "anthropic",
      modelId: "retired-outer-model",
      prompt: "[redacted]",
    });
    expect("contextEngine" in attempt).toBe(false);
    expect("contextTokenBudget" in attempt).toBe(false);
    expect("contextWindowInfo" in attempt).toBe(false);
  });

  it("does not apply outer context-overflow recovery to a locked Codex harness", async () => {
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        terminal: {
          kind: "failed",
          source: "prompt",
          error: new Error("request exceeds the model context window"),
        },
      }),
    );

    await runNativeSession("locked-codex-native-overflow").catch(() => undefined);

    expect(resolveModelAsyncMock).not.toHaveBeenCalled();
    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("preserves bundle MCP state across retries within one local run", async () => {
    refreshRuntimeAuthOnFirstPromptError = true;
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock
      .mockImplementationOnce(async () => {
        expect(disposeSessionMcpRuntimeMock).not.toHaveBeenCalled();
        return makeEmbeddedRunnerAttempt({
          terminal: { kind: "failed", source: "prompt", error: new Error("401 unauthorized") },
        });
      })
      .mockImplementationOnce(async () => {
        expect(disposeSessionMcpRuntimeMock).not.toHaveBeenCalled();
        return successfulAttempt();
      });

    const result = await runOpenAi({
      sessionKey,
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledWith("session:test");
  });

  it("surfaces prompt errors from the embedded attempt", async () => {
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-error"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        terminal: { kind: "failed", source: "prompt", error: new Error("boom") },
      }),
    );
    await expect(
      runTestAgent({
        sessionKey,
        config: cfg,
        prompt: "boom",
        provider: "openai",
        model: "mock-error",
      }),
    ).rejects.toThrow("boom");
  });
});
