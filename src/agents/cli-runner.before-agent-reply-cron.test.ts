/** Tests cron before_agent_reply gating at the CLI runner entrypoint. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type { HookRunner } from "../plugins/hooks.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import {
  getOrCreateSessionMcpRuntime,
  unopenedMcpConfig,
} from "./agent-bundle-mcp-manager.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { CliAuthProfilePreparationError } from "./cli-runner/auth-profile-preparation-error.js";
import { cliBackendLog } from "./cli-runner/log.js";
import { FailoverError } from "./failover-error.js";

type BeforeAgentReplyResult =
  | undefined
  | {
      handled?: boolean;
      reply?: { text?: string };
    };

const {
  hasHooksMock,
  replyMock,
  beforeRunMock,
  executeMock,
  prepareMock,
  closeSessionMock,
  closeLoopbackMock,
  retireKeyMock,
  retireMock,
  authStoreMock,
  authFailureMock,
  authSuccessMock,
} = vi.hoisted(() => ({
  hasHooksMock: vi.fn<(hookName: string) => boolean>(() => false),
  replyMock: vi.fn<(event: unknown, ctx: unknown) => Promise<BeforeAgentReplyResult>>(
    async () => undefined,
  ),
  beforeRunMock: vi.fn<HookRunner["runBeforeAgentRun"]>(async () => undefined),
  executeMock: vi.fn<(_context: unknown, _cliSessionIdToUse?: string) => Promise<CliOutput>>(
    async () => ({ text: "" }),
  ),
  prepareMock: vi.fn(),
  closeSessionMock: vi.fn(),
  closeLoopbackMock: vi.fn(),
  retireKeyMock: vi.fn(),
  retireMock: vi.fn(),
  authStoreMock: vi.fn(),
  authFailureMock: vi.fn(),
  authSuccessMock: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: hasHooksMock,
    runBeforeAgentReply: replyMock,
    runBeforeAgentRun: beforeRunMock,
  })),
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: prepareMock,
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executeMock,
}));

vi.mock("./cli-runner/cli-live-session-registry.js", () => ({
  closeCliLiveSession: closeSessionMock,
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: vi.fn(() => false),
  acceptsCliLiveSession: vi.fn(() => false),
}));

vi.mock("../gateway/mcp-http.js", () => ({
  closeMcpLoopbackServer: closeLoopbackMock,
}));

vi.mock("./agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: retireKeyMock,
  retireSessionMcpRuntime: retireMock,
}));

const runParams = {
  sessionId: "test-session",
  sessionKey: "test-session-key",
  agentId: "main",
  sessionFile: "/tmp/test-session.jsonl",
  workspaceDir: "/tmp/test-workspace",
  prompt: "__openclaw_memory_core_short_term_promotion_dream__",
  provider: "codex-cli",
  model: "gpt-5.5",
  timeoutMs: 30_000,
  runId: "test-run-id",
} as const;

type ProductionRunCliAgent = typeof import("./cli-runner.js").runCliAgent;
type TestRunCliAgent = (
  params: Omit<Parameters<ProductionRunCliAgent>[0], "admittedRunContext">,
) => ReturnType<ProductionRunCliAgent>;
let runCliAgent: TestRunCliAgent;
let restoreCliRunnerTestDeps: typeof import("./cli-runner.js").restoreCliRunnerTestDeps;
let setCliRunnerTestDeps: typeof import("./cli-runner.js").setCliRunnerTestDeps;

async function captureRejectedClaudeRun(
  params: Parameters<typeof runCliAgent>[0],
): Promise<{ error: unknown; events: DiagnosticEventPayload[] }> {
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
    if ("runId" in event && event.runId === params.runId) {
      events.push(event);
    }
  });
  let error: unknown;
  try {
    await runCliAgent(params);
  } catch (caught) {
    error = caught;
  } finally {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    unsubscribe();
  }
  return { error, events };
}

function makeStubContext(params: Parameters<ProductionRunCliAgent>[0]) {
  return {
    params,
    started: Date.now(),
    startedMonotonicMs: performance.now(),
    workspaceDir: params.workspaceDir,
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "",
    systemPromptReport: {},
    authEpochVersion: 0,
    backendResolved: {},
    preparedBackend: { backend: { sessionMode: "none" } },
    reusableCliSession: { mode: "none" },
  };
}

function prepareProfile(provider: string) {
  const profileId = `${provider}:selected`;
  const store = {
    version: 1,
    profiles: { [profileId]: { type: "api_key", provider, key: "secret" } },
  } as const;
  prepareMock.mockImplementationOnce(async (params) => ({
    ...makeStubContext(params),
    effectiveAuthProfileId: profileId,
    authProfileStore: store,
    agentDir: "/tmp/agent",
  }));
  return { profileId, store };
}

beforeEach(() => {
  hasHooksMock.mockReset().mockReturnValue(false);
  replyMock.mockReset().mockResolvedValue(undefined);
  beforeRunMock.mockReset().mockResolvedValue(undefined);
  executeMock.mockReset().mockResolvedValue({ text: "" });
  prepareMock.mockReset();
  prepareMock.mockImplementation(async (params) => makeStubContext(params));
  closeSessionMock.mockReset();
  closeLoopbackMock.mockReset();
  retireKeyMock.mockReset().mockResolvedValue(true);
  retireMock.mockReset().mockResolvedValue(true);
  authStoreMock.mockReset();
  authFailureMock.mockReset().mockResolvedValue(undefined);
  authSuccessMock.mockReset().mockResolvedValue(undefined);
  setCliRunnerTestDeps?.({
    loadAuthProfileStoreForRuntime: authStoreMock,
    markAuthProfileFailure: authFailureMock,
    markAuthProfileSuccess: authSuccessMock,
  });
});

beforeAll(async () => {
  const cliRunner = await import("./cli-runner.js");
  runCliAgent = wrapRunWithTestPreparedAdmission(cliRunner.runCliAgent);
  ({ restoreCliRunnerTestDeps, setCliRunnerTestDeps } = cliRunner);
});

afterEach(() => {
  restoreCliRunnerTestDeps();
  cliBackendsTesting.resetDepsForTest();
  vi.clearAllMocks();
  resetDiagnosticEventsForTest();
});

describe("runCliAgent before_agent_reply seam", () => {
  it("attributes terminal run and harness spans to the resolved execution owner", async () => {
    const runId = "run-owner-attribution";
    const events: DiagnosticEventPayload[] = [];
    setDiagnosticsEnabledForProcess(true);
    prepareMock.mockImplementationOnce(async (params) =>
      makeStubContext({ ...params, agentId: "main" }),
    );
    executeMock.mockResolvedValueOnce({ text: "ok" });
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if ("runId" in event && event.runId === runId) {
        events.push(event);
      }
    });
    try {
      await runCliAgent({
        ...runParams,
        sessionId: "owner-session",
        sessionKey: "agent:main:main",
        agentId: "worker",
        sessionFile: "/tmp/test-owner-session.jsonl",
        workspaceDir: "/tmp/test-owner-workspace",
        prompt: "visible ask",
        provider: "claude-cli",
        model: "sonnet-4.6",
        runId,
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      unsubscribe();
    }
    for (const type of ["harness.run.started", "run.started"]) {
      expect(events.find((event) => event.type === type)).toMatchObject({ agentId: "worker" });
    }
    for (const type of ["run.completed", "harness.run.completed"]) {
      expect(events.find((event) => event.type === type)).toMatchObject({ agentId: "main" });
    }
  });

  it("waits for execution-start work and rechecks cancellation before preparing the runtime", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const abort = new AbortController();
    const failure = new Error("run cancelled during execution-start work");
    const operation = runCliAgent({
      ...runParams,
      abortSignal: abort.signal,
      onExecutionStarted: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const outcome = operation.catch((error: unknown) => error);
    try {
      await entered.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(prepareMock).not.toHaveBeenCalled();
    } finally {
      abort.abort(failure);
      release.resolve();
      await outcome;
    }
    expect(await outcome).toBe(failure);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("settles one exhausted selected-profile failure", async () => {
    const provider = "claude-cli";
    const { profileId, store } = prepareProfile(provider);
    executeMock.mockRejectedValueOnce(
      new FailoverError("selected session expired", { reason: "session_expired", provider }),
    );

    await expect(runCliAgent({ ...runParams, provider, trigger: "user" })).rejects.toMatchObject({
      reason: "session_expired",
    });

    expect(authFailureMock).toHaveBeenCalledOnce();
    expect(authFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        store,
        profileId,
        reason: "session_expired",
        agentDir: "/tmp/agent",
      }),
    );
    expect(authSuccessMock).not.toHaveBeenCalled();
  });

  it("settles a typed selected-profile preparation failure before fallback", async () => {
    const provider = "claude-cli";
    const profileId = `${provider}:selected`;
    const store = {
      version: 1,
      profiles: { [profileId]: { type: "oauth", provider } },
    };
    authStoreMock.mockReturnValue(store);
    prepareMock.mockRejectedValueOnce(
      new CliAuthProfilePreparationError({
        message: "selected profile needs login",
        profileId,
        provider,
        agentDir: "/tmp/agent",
      }),
    );

    await expect(runCliAgent({ ...runParams, provider })).rejects.toMatchObject({
      name: "CliAuthProfilePreparationError",
      reason: "auth",
      profileId,
    });

    expect(authStoreMock).toHaveBeenCalledWith("/tmp/agent", expect.any(Object));
    expect(authFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ store, profileId, reason: "auth" }),
    );
  });

  it("records only success when fresh-session recovery succeeds and clears stale health", async () => {
    const profileId = "google-gemini-cli:selected";
    const store = {
      version: 1,
      profiles: {
        [profileId]: { type: "oauth", provider: "google-gemini-cli", access: "secret" },
      },
      usageStats: {
        [profileId]: { cooldownUntil: Date.now() + 60_000, cooldownReason: "session_expired" },
      },
    };
    prepareMock.mockImplementationOnce(async (params) => ({
      ...makeStubContext(params),
      effectiveAuthProfileId: profileId,
      authProfileStore: store,
      agentDir: "/tmp/agent",
      openClawHistoryPrompt: "history",
      reusableCliSession: { mode: "reuse", sessionId: "stale-session" },
      params: {
        ...params,
        onBeforeFreshCliSessionRetry: vi.fn(async () => true),
      },
    }));
    executeMock
      .mockRejectedValueOnce(
        new FailoverError("stale session", {
          reason: "session_expired",
          provider: "google-gemini-cli",
        }),
      )
      .mockResolvedValueOnce({ text: "recovered" });

    await expect(
      runCliAgent({ ...runParams, provider: "google-gemini-cli" }),
    ).resolves.toBeDefined();

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(authFailureMock).not.toHaveBeenCalled();
    expect(authSuccessMock).toHaveBeenCalledOnce();
    expect(authSuccessMock).toHaveBeenCalledWith({
      store,
      profileId,
      provider: "google-gemini-cli",
      agentDir: "/tmp/agent",
    });
  });

  it("does not settle auth health when before_agent_run blocks before backend execution", async () => {
    prepareProfile("codex-cli");
    const recorder = {
      persistBlocked: vi.fn(async (message) => ({ message })),
    } as unknown as NonNullable<Parameters<typeof runCliAgent>[0]["userTurnTranscriptRecorder"]>;
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_run");
    beforeRunMock.mockResolvedValueOnce({
      pluginId: "policy-plugin",
      decision: { outcome: "block", reason: "test policy", message: "Blocked by policy." },
    });

    await expect(
      runCliAgent({ ...runParams, userTurnTranscriptRecorder: recorder }),
    ).resolves.toMatchObject({ meta: { livenessState: "blocked" } });

    expect(executeMock).not.toHaveBeenCalled();
    expect(authFailureMock).not.toHaveBeenCalled();
    expect(authSuccessMock).not.toHaveBeenCalled();
  });

  it("does not settle selected-profile health for a pre-provider timeout", async () => {
    const error = new FailoverError("pre-provider timeout", {
      reason: "timeout",
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 30,
        observedActivity: false,
        activeToolCount: 0,
        backgroundTaskCount: 0,
      },
    });
    prepareProfile("claude-cli");
    executeMock.mockRejectedValueOnce(error);

    await expect(runCliAgent({ ...runParams, provider: "claude-cli" })).rejects.toBe(error);
    expect(authFailureMock).not.toHaveBeenCalled();
    expect(authSuccessMock).not.toHaveBeenCalled();
  });

  it.each([
    ["send", "CLI process failed"],
    ["resolve", "CLI backend returned an empty response."],
    ["cleanup", "managed session cleanup failed"],
  ] as const)("classifies the %s failure phase", async (phase, message) => {
    if (phase === "send") {
      executeMock.mockRejectedValueOnce(new Error(message));
    } else {
      executeMock.mockResolvedValueOnce({ text: phase === "resolve" ? "" : "real Claude reply" });
      if (phase === "cleanup") {
        closeSessionMock.mockRejectedValueOnce(new Error(message));
      }
    }
    const { error, events } = await captureRejectedClaudeRun({
      ...runParams,
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-opus-4-7",
      runId: `claude-${phase}-error`,
      cleanupCliLiveSessionOnRunEnd: phase !== "resolve",
      trigger: "cron",
      terminalReplyExpectation: "required",
    });
    expect(error).toMatchObject({ message });
    if (phase === "resolve") {
      expect(error).toMatchObject({
        name: "FailoverError",
        reason: "empty_response",
        provider: "claude-cli",
        model: "claude-opus-4-7",
        sessionId: runParams.sessionId,
      });
    } else {
      expect(closeSessionMock).toHaveBeenCalledOnce();
    }
    expect(events.find((event) => event.type === "harness.run.error")).toMatchObject({
      type: "harness.run.error",
      phase,
    });
  });

  it("rejects stale lifecycle ownership before CLI preparation", async () => {
    await expect(
      runCliAgent({
        ...runParams,
        lifecycleGeneration: "stale-generation",
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "Agent run belongs to a stale gateway lifecycle",
    });

    expect(prepareMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("lets before_agent_reply claim cron runs before the CLI subprocess is invoked", async () => {
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    replyMock.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed via cli runner" },
    });
    const onExecutionPhase = vi.fn();

    try {
      const result = await runCliAgent({
        ...runParams,
        trigger: "cron",
        jobId: "cron-job-123",
        chatId: "native-chat-123",
        onExecutionPhase,
      });

      expect(replyMock).toHaveBeenCalledTimes(1);
      expect(onExecutionPhase).toHaveBeenCalledWith({
        phase: "before_agent_reply",
        provider: runParams.provider,
        model: runParams.model,
      });
      const [event, context] = replyMock.mock.calls.at(0) ?? [];
      expect(event).toEqual({ cleanedBody: runParams.prompt });
      expect(context).toMatchObject({
        jobId: "cron-job-123",
        agentId: runParams.agentId,
        sessionId: runParams.sessionId,
        sessionKey: runParams.sessionKey,
        workspaceDir: runParams.workspaceDir,
        trigger: "cron",
      });
      const hookContext = context as Record<string, unknown> | undefined;
      expect(hookContext?.chatId).toBeUndefined();
      expect(hookContext?.channel).toBeUndefined();
      expect(prepareMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
      expect(result.payloads?.[0]?.text).toBe("dreaming claimed via cli runner");
      expect(result.meta.agentMeta?.sessionId).toBe("");
      expect(result.meta.agentMeta?.clearCliSessionBinding).toBeUndefined();

      const syntheticTurnLog = logInfoSpy.mock.calls
        .map(([message]) => message)
        .find((message) => message.startsWith("cli synthetic turn:"));
      // Synthetic turn logs prove the branch without leaking hook reply text.
      expect(syntheticTurnLog).toContain("provider=codex-cli");
      expect(syntheticTurnLog).toContain("model=<synthetic>");
      expect(syntheticTurnLog).toContain("requestedModel=gpt-5.5");
      expect(syntheticTurnLog).toContain("outBytes=31 outHash=96317e453543");
      expect(syntheticTurnLog).not.toContain("dreaming claimed via cli runner");
    } finally {
      logInfoSpy.mockRestore();
    }
  });

  it("clears stateless CLI bindings when before_agent_reply claims a cron turn", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "codex-cli",
          pluginId: "test-codex-cli",
          config: {
            command: "codex",
            args: ["exec"],
            output: "text",
            input: "arg",
            sessionMode: "none",
          },
        },
      ],
    });
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    replyMock.mockResolvedValue({ handled: true });

    const result = await runCliAgent({
      ...runParams,
      trigger: "cron",
      config: {},
    });

    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(result.payloads?.[0]?.text).toBe(SILENT_REPLY_TOKEN);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("marks a hook-claimed turn as never reaching a provider so capture skips its silence", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    replyMock.mockResolvedValue({ handled: true });

    const result = await runCliAgent({ ...runParams, trigger: "cron" });

    expect(result.meta).toMatchObject({
      finalAssistantRawText: "NO_REPLY",
      providerStarted: false,
    });
    const { resolveDiagnosticModelResponse } = await import("./diagnostic-model-response.js");
    expect(resolveDiagnosticModelResponse(result)).toBeUndefined();
  });

  it("dispatches a declining hook once when model fallback re-enters the CLI runner", async () => {
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    replyMock.mockResolvedValue(undefined);
    executeMock.mockResolvedValue({ text: "real reply" });
    const onExecutionPhase = vi.fn();

    await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), async () => {
      await runCliAgent({ ...runParams, trigger: "user", onExecutionPhase });
      await runCliAgent({
        ...runParams,
        trigger: "user",
        model: "fallback-model",
        onExecutionPhase,
      });
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(
      onExecutionPhase.mock.calls.filter(([event]) => event.phase === "before_agent_reply"),
    ).toHaveLength(1);
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "runtime_plugins",
      provider: runParams.provider,
      model: runParams.model,
    });
    expect(prepareMock).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("reports confirmed CLI messaging delivery evidence without leaking it to later invocations", async () => {
    executeMock.mockResolvedValueOnce({
      text: "sent",
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "telegram",
          to: "chat123",
        },
      ],
    });
    executeMock.mockResolvedValueOnce({ text: "later" });

    const firstResult = await runCliAgent(runParams);
    expect(firstResult.didSendViaMessagingTool).toBe(true);
    expect(firstResult.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat123",
      }),
    ]);

    const laterResult = await runCliAgent(runParams);
    expect(laterResult.didSendViaMessagingTool).toBeUndefined();
    expect(laterResult.messagingToolSentTargets).toBeUndefined();
  });

  it("does not retire a newer MCP runtime after its stable session key is rebound", async () => {
    const { setSessionMcpRuntimeScheduler } = await import("./agent-bundle-mcp-manager-api.js");
    const scheduler = createTestGatewayScheduler();
    onTestFinished(() => scheduler.stop());
    await setSessionMcpRuntimeScheduler(scheduler);
    const mcpTools = await vi.importActual<typeof import("./agent-bundle-mcp-tools.js")>(
      "./agent-bundle-mcp-tools.js",
    );
    const sessionKey = "agent:main:rebound-cli-cleanup";
    const originalSessionId = "rebound-cli-cleanup-original";
    const successorSessionId = "rebound-cli-cleanup-successor";
    const runtimeParams = {
      sessionKey,
      workspaceDir: runParams.workspaceDir,
      cfg: unopenedMcpConfig,
    };
    retireKeyMock.mockImplementation(mcpTools.retireSessionMcpRuntimeForSessionKey);
    retireMock.mockImplementation(mcpTools.retireSessionMcpRuntime);
    executeMock.mockResolvedValue({ text: "real reply" });

    try {
      await getOrCreateSessionMcpRuntime({
        ...runtimeParams,
        sessionId: originalSessionId,
      });
      const successorRuntime = await getOrCreateSessionMcpRuntime({
        ...runtimeParams,
        sessionId: successorSessionId,
      });
      expect(mcpTools.peekSessionMcpRuntime({ sessionKey })).toBe(successorRuntime);

      await runCliAgent({
        ...runParams,
        sessionId: originalSessionId,
        sessionKey,
        cleanupBundleMcpOnRunEnd: true,
      });

      expect(mcpTools.peekSessionMcpRuntime({ sessionId: originalSessionId })).toBeUndefined();
      expect(mcpTools.peekSessionMcpRuntime({ sessionId: successorSessionId })).toBe(
        successorRuntime,
      );
      expect(mcpTools.peekSessionMcpRuntime({ sessionKey })).toBe(successorRuntime);
      expect(retireKeyMock).not.toHaveBeenCalled();
      expect(closeLoopbackMock).not.toHaveBeenCalled();
    } finally {
      await mcpTools.retireSessionMcpRuntime({ sessionId: originalSessionId, reason: "test-end" });
      await mcpTools.retireSessionMcpRuntime({ sessionId: successorSessionId, reason: "test-end" });
    }
  });

  it.each([false, true])("settles failed MCP retirement with delivery %s", async (delivered) => {
    executeMock.mockResolvedValue(
      delivered ? { text: "", didSendViaMessagingTool: true } : { text: "real reply" },
    );
    retireMock.mockImplementation(async ({ onError }: { onError?: (error: unknown) => void }) => {
      onError?.(new Error("session mcp retire failed"));
      return false;
    });
    const result = runCliAgent({ ...runParams, cleanupBundleMcpOnRunEnd: true });
    if (delivered) {
      await expect(result).resolves.toMatchObject({ didSendViaMessagingTool: true });
    } else {
      await expect(result).rejects.toThrow("session mcp retire failed");
    }
  });
});
