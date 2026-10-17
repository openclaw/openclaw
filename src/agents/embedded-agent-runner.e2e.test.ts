// End-to-end embedded-agent runner tests with mocked model/runtime seams.
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  cleanupEmbeddedAgentRunnerTestWorkspace,
  createMockUsage,
  createEmbeddedAgentRunnerOpenAiConfig as createBaseEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
  createEmbeddedAgentRunnerTestWorkspace,
  type EmbeddedAgentRunnerTestWorkspace,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

type ProductionModelResolver = typeof import("./embedded-agent-runner/model.js").resolveModelAsync;
let resolveModelAsyncActual: ProductionModelResolver;

type EmbeddedRunnerModelResolution =
  | Awaited<ReturnType<ProductionModelResolver>>
  | ReturnType<typeof createResolvedEmbeddedRunnerModel>
  | {
      model?: undefined;
      error: string;
      authStorage: { setRuntimeApiKey: () => undefined };
      modelRegistry: Record<string, never>;
    };

const runEmbeddedAttemptMock = vi.fn();
const preparedPluginRegistry = createEmptyPluginRegistry();
const disposeSessionMcpRuntimeMock = vi.fn<(sessionId: string) => Promise<void>>(
  async () => undefined,
);
const resolveSessionKeyForRequestMock = vi.fn();
const resolveStoredSessionKeyForSessionIdMock = vi.fn();
const resolveModelAsyncMock = vi.fn(
  async (
    ...[provider, modelId]: Parameters<ProductionModelResolver>
  ): Promise<EmbeddedRunnerModelResolution> => createResolvedEmbeddedRunnerModel(provider, modelId),
);
const ensureOpenClawModelsJsonMock = vi.fn(async () => ({ wrote: false }));
const loggerWarnMock = vi.fn();
let refreshRuntimeAuthOnFirstPromptError = false;
let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;
let getReplyPayloadMetadata: typeof import("../auto-reply/reply-payload.js").getReplyPayloadMetadata;

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
  installEmbeddedRunnerBaseE2eMocks({
    hookRunner: "full",
    pluginRegistry: preparedPluginRegistry,
  });
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
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
  vi.doMock("./agent-bundle-mcp-tools.js", () => ({
    disposeSessionMcpRuntime: (sessionId: string) => disposeSessionMcpRuntimeMock(sessionId),
    retireSessionMcpRuntimeForSessionKey: () => Promise.resolve(false),
    retireSessionMcpRuntime: ({ sessionId }: { sessionId?: string | null }) =>
      sessionId ? disposeSessionMcpRuntimeMock(sessionId) : Promise.resolve(false),
  }));
  vi.doMock("./embedded-agent-runner/model.js", async () => {
    const actual = await vi.importActual<typeof import("./embedded-agent-runner/model.js")>(
      "./embedded-agent-runner/model.js",
    );
    resolveModelAsyncActual = actual.resolveModelAsync;
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
let SessionManager: typeof import("openclaw/plugin-sdk/agent-sessions").SessionManager;
let loadTranscriptEvents: typeof import("../config/sessions/session-accessor.js").loadTranscriptEvents;
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

function createRuntimeConfig(modelIds: string[], model: string, runtime: "codex" | "openclaw") {
  const cfg = createEmbeddedAgentRunnerOpenAiConfig(modelIds);
  const provider = cfg.models?.providers?.openai;
  if (!provider) {
    throw new Error("expected OpenAI provider test config");
  }
  provider.baseUrl = "https://api.openai.com/v1";
  cfg.agents = {
    ...cfg.agents,
    defaults: {
      ...cfg.agents?.defaults,
      models: { [model]: { agentRuntime: { id: runtime } } },
    },
  };
  return cfg;
}

beforeAll(async () => {
  vi.useRealTimers();
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ getReplyPayloadMetadata } = await import("../auto-reply/reply-payload.js"));
  ({ setRuntimeConfigSnapshot } = await import("../config/config.js"));
  runEmbeddedAgent = wrapRunWithTestPreparedAdmission(
    (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
  );
  ({ SessionManager } = await import("openclaw/plugin-sdk/agent-sessions"));
  ({ loadTranscriptEvents, upsertSessionEntryCore } =
    await import("../config/sessions/session-accessor.js"));
  ({ resolveAgentRunSessionTarget } = await import("./run-session-target.js"));
  e2eWorkspace = await createEmbeddedAgentRunnerTestWorkspace("openclaw-embedded-agent-");
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
        models: modelIds.map((id) => ({
          id,
          name: `Mock ${id}`,
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_000,
          maxTokens: 2048,
        })),
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

function firstRunEmbeddedAttemptParams(): { sessionKey?: string } {
  const call = runEmbeddedAttemptMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected embedded attempt to be called");
  }
  return call[0] as { sessionKey?: string };
}

const createPersistedTestSessionManager = async (params: {
  config?: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>;
  sessionId: string;
  sessionKey: string;
}) => {
  const target = await resolveTestSessionTarget(params);
  await upsertSessionEntryCore(
    { agentId: target.agentId, sessionKey: target.sessionKey, storePath: target.storePath },
    { sessionId: target.sessionId, updatedAt: Date.now() },
  );
  return SessionManager.open(target, workspaceDir);
};

const textFromContent = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const readSessionMessages = async (params: {
  config?: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>;
  sessionId: string;
  sessionKey: string;
}) => {
  const entries = await loadTranscriptEvents(await resolveTestSessionTarget(params));
  return entries
    .filter((entry): entry is { message?: { role?: string; content?: unknown }; type: "message" } =>
      Boolean(entry && typeof entry === "object" && "type" in entry && entry.type === "message"),
    )
    .map((entry) => entry.message);
};

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

const expectResolvedModel = (
  cfg: ReturnType<typeof createEmbeddedAgentRunnerOpenAiConfig>,
  provider: string,
  model: string,
) =>
  expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
    1,
    provider,
    model,
    agentDir,
    cfg,
    expect.objectContaining({ skipAgentDiscovery: true }),
  );

describe("runEmbeddedAgent", () => {
  it("uses runtime config for blank public runtime model overrides", async () => {
    const baseConfig = createEmbeddedAgentRunnerOpenAiConfig([]);
    const cfg = {
      ...baseConfig,
      agents: {
        ...baseConfig.agents,
        defaults: {
          ...baseConfig.agents?.defaults,
          model: {
            primary: "openrouter/runtime-default",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    mockSuccessfulEmbeddedAttempt();

    await runTestAgent({
      sessionId: "runtime-config-default-model",
      provider: " ",
      model: "",
    });

    expectResolvedModel(cfg, "openrouter", "openrouter/runtime-default");
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

    expectResolvedModel(cfg, "anthropic", "claude-opus-4-7");
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string; id?: string } }).model,
    ).toEqual(expect.objectContaining({ provider: "anthropic", id: "claude-opus-4-7" }));
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

    expectResolvedModel(cfg, "anthropic", "claude-sonnet-4-6");
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string; id?: string } }).model,
    ).toEqual(expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-6" }));
  });

  it("resolves transport-owned OpenAI Codex runs against the runtime provider first", async () => {
    const cfg = createRuntimeConfig([], "openai/gpt-5.5", "codex");
    resolveModelAsyncMock.mockImplementation(async (provider: string, modelId: string) => {
      if (provider === "openai" && modelId === "gpt-5.5") {
        const resolved = createResolvedEmbeddedRunnerModel(provider, modelId);
        return { ...resolved, model: { ...resolved.model, contextWindow: 272_000 } };
      }
      return {
        error: `Unknown model: ${provider}/${modelId}`,
        authStorage: { setRuntimeApiKey: () => undefined },
        modelRegistry: {},
      };
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(successfulAttempt({ contextTokens: 1_050_000 }));

    const result = await runTestAgent({
      sessionId: "codex-runtime-model",
      config: cfg,
      provider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "codex",
    });

    expectResolvedModel(cfg, "openai", "gpt-5.5");
    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai");
    expect(result.meta.agentMeta?.contextTokens).toBe(1_050_000);
  });

  it.each([
    {
      label: "configured",
      baseUrl: "https://configured.example.test/proxy/v1",
      expectedBaseUrl: "https://configured.example.test/proxy/v1",
    },
    { label: "static fallback", baseUrl: "", expectedBaseUrl: "https://static.example.test/v1" },
  ])(
    "keeps the $label endpoint when runEmbeddedAgent rematerializes a stored profile",
    async ({ baseUrl, expectedBaseUrl }) => {
      const { writePersistedAuthProfileStoreRaw } = await import("./auth-profiles/sqlite.js");
      const { clearRuntimeAuthProfileStoreSnapshot } = await import("./auth-profiles.js");
      const staticCatalog = await import("./embedded-agent-runner/model.static-catalog.js");
      const materializer = vi.mocked(
        (await import("./runtime-plan/materialize-model.js")).materializePreparedRuntimeModel,
      );
      const previousMaterializer = materializer.getMockImplementation();
      if (!previousMaterializer) {
        throw new Error("expected the fast runner materialization fixture");
      }
      materializer.mockImplementation(
        (
          await vi.importActual<typeof import("./runtime-plan/materialize-model.js")>(
            "./runtime-plan/materialize-model.js",
          )
        ).materializePreparedRuntimeModel,
      );
      const provider = "proxy-fixture";
      const modelId = "static-chat";
      const configuredBaseUrl = baseUrl;
      const config = {
        ...createEmbeddedAgentRunnerOpenAiConfig([]),
        models: {
          providers: {
            [provider]: {
              api: "openai-completions" as const,
              baseUrl: configuredBaseUrl,
              models: [],
            },
          },
        },
      };
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: { "proxy-fixture:stored": { type: "api_key", provider, key: "synthetic-key" } },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshot(agentDir);
      const catalog = vi.spyOn(staticCatalog, "resolveBundledStaticCatalogModel").mockReturnValue({
        provider,
        id: modelId,
        name: "Static chat fixture",
        api: "openai-completions",
        baseUrl: "https://static.example.test/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 2_048,
      });
      const { createEmptyAgentDiscoveryStores } = await vi.importActual<
        typeof import("./embedded-agent-runner/model.js")
      >("./embedded-agent-runner/model.js");
      const stores = createEmptyAgentDiscoveryStores();
      resolveModelAsyncMock.mockImplementation(
        (lookupProvider, lookupModelId, lookupAgentDir, lookupConfig, options) =>
          resolveModelAsyncActual(lookupProvider, lookupModelId, lookupAgentDir, lookupConfig, {
            ...options,
            ...stores,
          }),
      );
      mockSuccessfulEmbeddedAttempt();
      try {
        await runTestAgent({
          sessionId: nextRunId("proxy-profile"),
          sessionFile: nextSessionCompatibilityKey(),
          config,
          provider,
          model: modelId,
          authProfileId: "proxy-fixture:stored",
          authProfileIdSource: "user",
        });
        expect(resolveModelAsyncMock.mock.calls.length).toBeGreaterThan(1);
        expect(firstRunEmbeddedAttemptParams()).toMatchObject({
          model: { provider, id: modelId, baseUrl: expectedBaseUrl, api: "openai-completions" },
        });
      } finally {
        catalog.mockRestore();
        materializer.mockImplementation(previousMaterializer);
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
        clearRuntimeAuthProfileStoreSnapshot(agentDir);
      }
    },
  );

  it("lets a locked Codex harness own stale model resolution and context policy", async () => {
    const cfg = createEmbeddedAgentRunnerOpenAiConfig([]);
    const nativeSession = await createNativeSessionFixture(cfg, "locked-codex-native-policy");
    const prompt = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
    resolveModelAsyncMock.mockRejectedValueOnce(new Error("stale outer model must not resolve"));
    mockSuccessfulEmbeddedAttempt();

    await runTestAgent({
      ...nativeSession,
      config: cfg,
      prompt,
      provider: "anthropic",
      model: "retired-outer-model",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });

    expect(resolveModelAsyncMock).not.toHaveBeenCalled();
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
    const attempt = firstRunEmbeddedAttemptParams() as Record<string, unknown>;
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
    const cfg = createEmbeddedAgentRunnerOpenAiConfig([]);
    const nativeSession = await createNativeSessionFixture(cfg, "locked-codex-native-overflow");
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        terminal: {
          kind: "failed",
          source: "prompt",
          error: new Error("request exceeds the model context window"),
        },
      }),
    );

    await runTestAgent({
      ...nativeSession,
      config: cfg,
      provider: "anthropic",
      model: "retired-outer-model",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    }).catch(() => undefined);

    expect(resolveModelAsyncMock).not.toHaveBeenCalled();
    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
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
      await runTestAgent({
        sessionId,
        sessionKey: "   ",
        config: cfg,
        provider: "openai",
        model: "mock-1",
        ...(resolved === undefined ? { sessionFile: sessionId } : {}),
      });
      expect(resolveSessionKeyForRequestMock).toHaveBeenCalledWith({
        cfg,
        sessionId,
        agentId: undefined,
      });
      expect(firstRunEmbeddedAttemptParams().sessionKey).toBe(expected);
    },
  );

  it("logs when embedded session-key backfill resolution fails", async () => {
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockImplementation(() => {
      throw new Error("resolver exploded");
    });
    mockSuccessfulEmbeddedAttempt();

    await runTestAgent({
      sessionId: "resume-456",
      config: cfg,
      provider: "openai",
      model: "mock-1",
    });

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

    await runTestAgent({
      sessionId: "resume-agent-1",
      sessionKey: undefined,
      config: cfg,
      provider: "openai",
      model: "mock-1",
      agentId: "embedded-agent",
    });

    expect(resolveStoredSessionKeyForSessionIdMock).toHaveBeenCalledWith({
      cfg,
      sessionId: "resume-agent-1",
      agentId: "embedded-agent",
    });
    expect(resolveSessionKeyForRequestMock).not.toHaveBeenCalled();
  });

  it("preserves bundle MCP state across retries within one local run", async () => {
    refreshRuntimeAuthOnFirstPromptError = true;
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
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

    const result = await runTestAgent({
      sessionKey,
      config: cfg,
      provider: "openai",
      model: "mock-1",
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledWith("session:test");
  });

  it("preserves harness-owned media provenance through terminal preparation", async () => {
    const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        toolMediaUrls: ["/tmp/generated.png"],
        hostOwnedToolMediaUrls: ["/tmp/generated.png"],
      }),
    );

    const result = await runTestAgent({
      config: cfg,
      prompt: "generate an image",
      provider: "openai",
      model: "mock-1",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result.payloads).toHaveLength(1);
    expect(result.payloads?.[0]).toMatchObject({
      mediaUrls: ["/tmp/generated.png"],
      mediaUrl: "/tmp/generated.png",
    });
    expect(getReplyPayloadMetadata(result.payloads?.[0] ?? {})).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
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

  it("resolves explicit OpenAI OpenClaw runs through Codex when auth order starts with Codex OAuth", async () => {
    const cfg = createRuntimeConfig(["mock-1"], "openai/mock-1", "openclaw");
    cfg.auth = { order: { openai: ["openai:work", "openai:backup"] } };
    mockSuccessfulEmbeddedAttempt();

    await runTestAgent({
      sessionId: "codex-first-openclaw",
      config: cfg,
      provider: "openai",
      model: "mock-1",
    });

    expectResolvedModel(cfg, "openai", "mock-1");
    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expect(
      (firstRunEmbeddedAttemptParams() as { model?: { provider?: string } }).model?.provider,
    ).toBe("openai");
  });

  it(
    "preserves existing transcript entries across an additional turn",
    { timeout: 15_000 },
    async () => {
      const sessionFile = nextSessionCompatibilityKey();
      const sessionKey = nextSessionKey();
      const cfg = createEmbeddedAgentRunnerOpenAiConfig(["mock-error"]);

      const sessionManager = await createPersistedTestSessionManager({
        config: cfg,
        sessionId: "session:test",
        sessionKey,
      });
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "seed user" }],
        timestamp: Date.now(),
      });
      sessionManager.appendMessage(
        buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text: "seed assistant" }],
          usage: createMockUsage(1, 1),
        }),
      );

      mockSuccessfulEmbeddedAttempt();
      await runTestAgent({
        sessionFile,
        sessionKey,
        config: cfg,
        provider: "openai",
        model: "mock-error",
      });

      const messages = await readSessionMessages({
        config: cfg,
        sessionId: "session:test",
        sessionKey,
      });
      const seedUserIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "seed user",
      );
      const seedAssistantIndex = messages.findIndex(
        (message) =>
          message?.role === "assistant" && textFromContent(message.content) === "seed assistant",
      );
      expect(seedUserIndex).toBeGreaterThanOrEqual(0);
      expect(seedAssistantIndex).toBeGreaterThan(seedUserIndex);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    },
  );
});
