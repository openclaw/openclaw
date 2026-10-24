import type { CopilotClient, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AgentHarness,
  AgentHarnessCompactParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotSessionBinding } from "./harness.js";
import {
  asAttemptParams,
  asCompleteAttemptResult,
  asFinalizationAttempt,
  createCopilotAgentHarness,
  makeSessionStoreMock,
} from "./harness.test-support.js";
import type { CopilotAttemptDeps } from "./src/attempt-types.js";
import type { resolvePoolAcquire } from "./src/attempt.js";
import { createCopilotIsolatedCompletionParams } from "./src/isolated-completion.test-support.js";
import type { CopilotClientPool, PoolKey } from "./src/runtime.js";

type AgentHarnessIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarness["runIsolatedCompletionV2"]>
>[0];

const COPILOT_BYOK_PROVIDER_ERROR =
  "[copilot-attempt] BYOK requires an OpenAI-compatible or Anthropic model api and a non-empty baseUrl";

const mocks = vi.hoisted(() => ({
  runCopilotAttempt: vi.fn(),
  resolvePoolAcquire: vi.fn<typeof resolvePoolAcquire>(),
  createCopilotByokProxy: vi.fn(),
  createCopilotClientPool: vi.fn(),
}));

vi.mock("./src/attempt.js", () => ({
  resolvePoolAcquire: mocks.resolvePoolAcquire,
  runCopilotAttempt: mocks.runCopilotAttempt,
}));

vi.mock("./src/byok-proxy.js", () => ({
  createCopilotByokProxy: mocks.createCopilotByokProxy,
}));

vi.mock("./src/runtime.js", () => ({
  createCopilotClientPool: mocks.createCopilotClientPool,
}));

const ATTEMPT_PARAMS = asAttemptParams({
  provider: "github-copilot",
  model: "gpt-4.1",
});
const ATTEMPT_RESULT = asCompleteAttemptResult({ ok: true });
const TEST_POOL_KEY = {
  agentId: "test",
  authMode: "useLoggedInUser",
  copilotHome: "/tmp/copilot",
} satisfies PoolKey;
const TEST_SESSION_CONFIG = {
  availableTools: [],
  model: "gpt-4.1",
  tools: [],
  workingDirectory: "/workspace",
};

const ISOLATED_COMPLETION_PARAMS = createCopilotIsolatedCompletionParams({ thinkLevel: "high" });

function createMockCopilotClient(overrides: Record<string, unknown> = {}): CopilotClient {
  return overrides as unknown as CopilotClient;
}

function mockEstablishedSession(
  sdkSessionId: string,
  createClient: () => CopilotClient = createMockCopilotClient,
  sessionConfig?: SessionConfig,
) {
  mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
    await deps.onSessionEstablished?.({
      sdkSessionId,
      pooledClient: { key: TEST_POOL_KEY, client: createClient() },
      ...(sessionConfig ? { sessionConfig } : {}),
    });
    return ATTEMPT_RESULT;
  });
}

function established(sdkSessionId: string, client = createMockCopilotClient()) {
  return {
    sdkSessionId,
    pooledClient: { key: TEST_POOL_KEY, client },
    sessionConfig: TEST_SESSION_CONFIG,
  };
}

function makeAttemptParams(overrides: Record<string, unknown> = {}): any {
  return {
    provider: "github-copilot",
    model: "gpt-4.1",
    cwd: "/ws",
    workspaceDir: "/ws",
    agentDir: "/home",
    copilotHome: "/copilot-home",
    auth: { useLoggedInUser: true },
    sessionId: "oc-sess-reuse",
    ...overrides,
  };
}

function makeCompactParams(overrides: Record<string, unknown> = {}): any {
  return makeAttemptParams({
    model: { provider: "github-copilot", id: "gpt-4.1" },
    sessionId: "oc-sess-compact",
    sessionFile: "/session.json",
    ...overrides,
  });
}

function runTurn(harness: ReturnType<typeof createCopilotAgentHarness>, overrides = {}) {
  return harness.runAttempt(makeAttemptParams(overrides));
}

function compactHarness(harness: ReturnType<typeof createCopilotAgentHarness>, overrides = {}) {
  return harness.compact?.(makeCompactParams(overrides));
}

function replayAt(index: number) {
  const params = mocks.runCopilotAttempt.mock.calls[index]?.[0];
  expect(params).toBeDefined();
  return params?.initialReplayState;
}
const failedCompaction = (reason: string, rawError?: string) => ({
  ok: false,
  compacted: false,
  reason,
  failure: { reason, ...(rawError === undefined ? {} : { rawError }) },
});

function makePoolMock() {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn().mockResolvedValue([]),
    size: vi.fn().mockReturnValue(0),
  } satisfies CopilotClientPool;
}

function isolatedFixture(
  data: Extract<SessionEvent, { type: "assistant.message" }>["data"] = {
    content: "",
    messageId: "message-1",
  },
) {
  const session = {
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendAndWait: vi.fn().mockResolvedValue({
      type: "assistant.message",
      id: "event-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      data,
    }),
  };
  const createSession = vi.fn().mockResolvedValue(session);
  const resumeSession = vi.fn();
  const client = createMockCopilotClient({ createSession, resumeSession });
  const handle = { client, key: TEST_POOL_KEY };
  const pool = makePoolMock();
  pool.acquire.mockResolvedValue(handle);
  return {
    harness: createCopilotAgentHarness({ pool }),
    pool,
    client,
    handle,
    createSession,
    resumeSession,
    session,
    ...session,
  };
}

function setupCompaction(sdkSessionId: string, resumeSession: ReturnType<typeof vi.fn>) {
  const pool = makePoolMock();
  const client = createMockCopilotClient({ deleteSession: vi.fn(), resumeSession });
  pool.acquire.mockResolvedValue({ key: TEST_POOL_KEY, client });
  pool.release.mockResolvedValue(undefined);
  mockEstablishedSession(sdkSessionId, () => client, TEST_SESSION_CONFIG);
  return { pool, harness: createCopilotAgentHarness({ pool }) };
}

function compactSession(result = { success: true, tokensRemoved: 45, messagesRemoved: 2 }) {
  const compact = vi.fn(async () => structuredClone(result));
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const session = { disconnect, rpc: { history: { compact } } };
  const resumeSession = vi.fn(async () => session);
  return { compact, disconnect, resumeSession, session };
}

function storedHarness(sessionStore: ReturnType<typeof makeSessionStoreMock>) {
  return createCopilotAgentHarness({ pool: makePoolMock(), sessionStore: sessionStore.store });
}

async function flushAsyncWork() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("createCopilotAgentHarness", () => {
  beforeEach(() => {
    mocks.runCopilotAttempt.mockReset();
    mocks.resolvePoolAcquire.mockClear();
    mocks.createCopilotByokProxy.mockReset();
    mocks.createCopilotClientPool.mockReset();
    mocks.runCopilotAttempt.mockResolvedValue(ATTEMPT_RESULT);
    mocks.resolvePoolAcquire.mockReturnValue({
      auth: {
        agentId: "test",
        authMode: "useLoggedInUser",
        copilotHome: "/tmp/copilot",
      },
      key: { agentId: "test", authMode: "useLoggedInUser", copilotHome: "/tmp/copilot" },
      options: { copilotHome: "/tmp/copilot", useLoggedInUser: true },
      provider: { mode: "github-copilot" },
    });
    mocks.createCopilotClientPool.mockImplementation(() => makePoolMock());
    mocks.createCopilotByokProxy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it.each([
    ["auto runtime", { provider: "github-copilot", requestedRuntime: "auto" }],
    ["missing BYOK shape", {}],
    [
      "request transport overrides",
      {
        modelProvider: {
          api: "openai-responses",
          baseUrl: "https://proxy.example/v1",
          request: { proxy: { mode: "env-proxy" } },
        },
      },
    ],
  ] satisfies Array<[string, Partial<Parameters<AgentHarness["supports"]>[0]>]>)(
    "supports rejects %s",
    (name, overrides) => {
      const harness = createCopilotAgentHarness();
      expect(harness.autoSelection?.providerIds).toEqual([]);
      expect(
        harness.supports({
          provider: "custom-proxy",
          modelId: "gpt-4.1",
          requestedRuntime: "copilot",
          providerOwnerStatus: "unowned",
          providerOwnerPluginIds: [],
          ...overrides,
        }),
      ).toEqual({
        supported: false,
        reason:
          name === "auto runtime"
            ? "copilot is opt-in only"
            : "provider is not a supported Copilot BYOK model (requires supported api, baseUrl, and no request transport policy overrides)",
      });
    },
  );

  it("keeps invalid BYOK provider configuration on the structured attempt path", async () => {
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.resolvePoolAcquire.mockImplementationOnce(() => {
      throw new Error(COPILOT_BYOK_PROVIDER_ERROR);
    });
    const harness = createCopilotAgentHarness();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);
    expect(mocks.runCopilotAttempt).toHaveBeenCalledWith(ATTEMPT_PARAMS, { pool });
  });

  it("finalizes settled tools by resuming the compatible SDK session in isolated mode", async () => {
    const pool = makePoolMock();
    const client = createMockCopilotClient({ deleteSession: vi.fn() });
    const settledResult = asCompleteAttemptResult({ assistantTexts: [] });
    const finalAssistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "final answer" }],
      stopReason: "stop" as const,
    };
    const finalResult = asCompleteAttemptResult({
      assistantTexts: ["final answer"],
      currentAttemptCompletedAssistant: finalAssistant,
    });
    const params = asAttemptParams({
      ...ATTEMPT_PARAMS,
      initialReplayState: { replayInvalid: true },
      onAgentEvent: vi.fn(),
      onAssistantDelta: vi.fn(),
      onPartialReply: vi.fn(),
      sessionId: "openclaw-session-finalize",
    });
    mocks.runCopilotAttempt
      .mockImplementationOnce(async (_params, deps) => {
        await deps.onSessionEstablished?.({
          sdkSessionId: "sdk-session-finalize",
          pooledClient: { client, key: TEST_POOL_KEY },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return settledResult;
      })
      .mockResolvedValueOnce(finalResult);
    const harness = createCopilotAgentHarness({ pool });

    await expect(harness.runAttempt(params)).resolves.toBe(settledResult);
    await expect(
      harness.finalizeSettledTurn?.({
        attempt: asFinalizationAttempt(params),
        settledAttempt: settledResult,
      }),
    ).resolves.toEqual({
      assistant: finalAssistant,
      preparedTerminalReply: {
        text: "final answer",
        terminalReply: { disposition: "visible", text: "final answer" },
      },
    });

    expect(mocks.runCopilotAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.runCopilotAttempt.mock.calls[1]?.[0]).toMatchObject({
      initialReplayState: { sdkSessionId: "sdk-session-finalize" },
      sessionId: "openclaw-session-finalize",
    });
    expect(mocks.runCopilotAttempt.mock.calls[1]?.[0]?.initialReplayState).not.toHaveProperty(
      "replayInvalid",
    );
    expect(mocks.runCopilotAttempt.mock.calls[1]?.[1]).toMatchObject({
      operation: "settled-tool-finalization",
      pool,
    });
    expect(mocks.runCopilotAttempt.mock.calls[1]?.[1]?.onSessionEstablished).toBeUndefined();
  });

  it("fails closed when settled finalization has no compatible SDK session", async () => {
    const harness = createCopilotAgentHarness({ pool: makePoolMock() });
    const params = asAttemptParams({
      ...ATTEMPT_PARAMS,
      sessionId: "openclaw-session-missing",
    });

    await expect(
      harness.finalizeSettledTurn?.({
        attempt: asFinalizationAttempt(params),
        settledAttempt: ATTEMPT_RESULT,
      }),
    ).rejects.toThrow(
      "cannot safely finalize a settled tool turn without its compatible SDK session",
    );
    expect(mocks.runCopilotAttempt).not.toHaveBeenCalled();
  });

  it("selects a normalized native provider and runs an isolated session with no capability surface", async () => {
    const { harness, pool, client, createSession, resumeSession, sendAndWait, disconnect } =
      isolatedFixture({
        content: "Four.",
        messageId: "message-1",
        model: "gpt-4.1",
        outputTokens: 2,
      });
    expect(
      harness.supports({
        provider: "  GitHub-Copilot  ",
        modelId: "gpt-4.1",
        requestedRuntime: "  COPILOT  ",
      }),
    ).toEqual({ supported: true, priority: 100 });

    await expect(
      harness.runIsolatedCompletionV2?.({
        ...ISOLATED_COMPLETION_PARAMS,
        streamParams: { maxTokens: 800, temperature: 0.2 },
      }),
    ).resolves.toEqual({
      assistant: expect.objectContaining({
        content: [{ type: "text", text: "Four." }],
        model: "gpt-4.1",
        provider: "github-copilot",
        stopReason: "stop",
      }),
    });

    expect(pool.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        authMode: "gitHubToken",
        authProfileId: "github:work",
        authProfileVersion: "prepared-owner-fingerprint",
        clientMode: "empty",
      }),
      expect.objectContaining({
        gitHubToken: "prepared-github-token",
        mode: "empty",
        useLoggedInUser: false,
      }),
    );
    expect(createSession).toHaveBeenCalledOnce();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        availableTools: [],
        coauthorEnabled: false,
        customAgents: [],
        enableConfigDiscovery: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableOnDemandInstructionDiscovery: false,
        enableSessionStore: false,
        enableSkills: false,
        excludedTools: ["builtin:*", "mcp:*", "custom:*"],
        includeSubAgentStreamingEvents: false,
        manageScheduleEnabled: false,
        mcpServers: {},
        memory: { enabled: false },
        model: "gpt-4.1",
        pluginDirectories: [],
        requestCanvasRenderer: false,
        requestExtensions: false,
        skillDirectories: [],
        skipCustomInstructions: true,
        skipEmbeddingRetrieval: true,
        systemMessage: {
          mode: "replace",
          content: "Answer only from the supplied prompt.",
        },
        tools: [],
      }),
    );
    const sessionConfig = createSession.mock.calls[0]?.[0];
    expect(sessionConfig).not.toHaveProperty("hooks");
    expect(sessionConfig).not.toHaveProperty("maxTokens");
    expect(sessionConfig).not.toHaveProperty("onEvent");
    expect(sessionConfig).not.toHaveProperty("onPermissionRequest");
    expect(sessionConfig).not.toHaveProperty("onUserInputRequest");
    expect(sessionConfig).not.toHaveProperty("temperature");
    expect(sendAndWait).toHaveBeenCalledWith(
      { prompt: "What is two plus two?" },
      expect.any(Number),
    );
    expect(sendAndWait.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(sendAndWait.mock.calls[0]?.[1]).toBeLessThanOrEqual(30_000);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(pool.release).toHaveBeenCalledWith(expect.objectContaining({ client }));
  });

  it.each([
    {
      name: "harness-owned authorization",
      params: {
        ...ISOLATED_COMPLETION_PARAMS,
        authorization: {
          owner: "harness",
          plan: {
            providerForAuth: "github-copilot",
            authProfileProviderForAuth: "github-copilot",
          },
          authProfileStore: { version: 1, profiles: {} },
        },
      } satisfies AgentHarnessIsolatedCompletionParams,
      reason: "requires host-prepared authorization",
    },
    {
      name: "unsupported thinking level",
      params: {
        ...ISOLATED_COMPLETION_PARAMS,
        thinkLevel: "off",
      } satisfies AgentHarnessIsolatedCompletionParams,
      reason: "does not support thinking level off",
    },
  ])("rejects $name before acquiring a client", async ({ params, reason }) => {
    const pool = makePoolMock();
    const harness = createCopilotAgentHarness({ pool });
    await expect(harness.runIsolatedCompletionV2?.(params)).rejects.toThrow(reason);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("returns tool-shaped output for core to reject with its stable code", async () => {
    const { harness, session, pool } = isolatedFixture({
      content: "",
      messageId: "message-1",
      toolRequests: [{ toolCallId: "call-1", name: "shell", arguments: {} }],
    });

    await expect(harness.runIsolatedCompletionV2?.(ISOLATED_COMPLETION_PARAMS)).resolves.toEqual({
      assistant: expect.objectContaining({
        content: [{ type: "toolCall", id: "call-1", name: "shell", arguments: {} }],
        stopReason: "toolUse",
      }),
    });
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(pool.release).toHaveBeenCalledOnce();
  });

  it.each(["client acquisition", "session creation"] as const)(
    "releases resources without further SDK dispatch when the owner is revoked during %s",
    async (stage) => {
      const controller = new AbortController();
      const retired = new Error("isolated completion owner retired");
      let current = true;
      const { harness, pool, session, createSession, handle } = isolatedFixture({
        content: "Must not be returned",
        messageId: "revoked-owner",
      });
      const sessionReady = createDeferred<typeof session>();
      createSession.mockReturnValue(
        stage === "session creation" ? sessionReady.promise : Promise.resolve(session),
      );
      const handleReady = createDeferred<typeof handle>();
      pool.acquire.mockReturnValue(
        stage === "client acquisition" ? handleReady.promise : Promise.resolve(handle),
      );
      pool.release.mockResolvedValue(undefined);
      const pending = harness.runIsolatedCompletionV2?.({
        ...ISOLATED_COMPLETION_PARAMS,
        abortSignal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw retired;
          }
        },
      });
      try {
        await vi.waitFor(() =>
          expect(
            stage === "client acquisition" ? pool.acquire : createSession,
          ).toHaveBeenCalledOnce(),
        );
        current = false;
      } finally {
        handleReady.resolve(handle);
        sessionReady.resolve(session);
      }

      await expect(pending).rejects.toBe(retired);
      await flushAsyncWork();
      expect(controller.signal.aborted).toBe(false);
      expect(session.sendAndWait).not.toHaveBeenCalled();
      expect(pool.release).toHaveBeenCalledExactlyOnceWith(handle);
      if (stage === "client acquisition") {
        expect(createSession).not.toHaveBeenCalled();
      } else {
        expect(session.abort).toHaveBeenCalledOnce();
        expect(session.disconnect).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not start a request when cancellation wins the send boundary", async () => {
    const controller = new AbortController();
    let boundaryRegistrations = 0;
    const addEventListener = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
      addEventListener(...args);
      boundaryRegistrations += 1;
      if (boundaryRegistrations === 5) {
        queueMicrotask(() => controller.abort(new Error("cancelled at send boundary")));
      }
    });
    const { harness, session, sendAndWait } = isolatedFixture();
    sendAndWait.mockReset();

    await expect(
      harness.runIsolatedCompletionV2?.({
        ...ISOLATED_COMPLETION_PARAMS,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("cancelled at send boundary");
    await flushAsyncWork();
    expect(boundaryRegistrations).toBe(5);
    expect(sendAndWait).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects a late session after its deadline even when abort wedges", async () => {
    const started = createDeferred<void>();
    const released = createDeferred<void>();
    const disconnected = createDeferred<void>();
    const { harness, session, createSession, pool, handle } = isolatedFixture();
    session.abort.mockReturnValue(new Promise<void>(() => {}));
    session.disconnect.mockImplementation(async () => disconnected.resolve());
    session.sendAndWait.mockReset();
    const ready = createDeferred<typeof session>();
    createSession.mockImplementation(() => {
      started.resolve();
      return ready.promise;
    });
    pool.release.mockImplementation(async () => released.resolve());
    vi.useFakeTimers();
    try {
      const completion = harness.runIsolatedCompletionV2?.({
        ...ISOLATED_COMPLETION_PARAMS,
        timeoutMs: 5,
      });
      const rejected = expect(completion).rejects.toThrow("timed out after 5ms");
      await started.promise;
      await vi.advanceTimersByTimeAsync(5);
      await rejected;
      ready.resolve(session);
      await released.promise;
      await disconnected.promise;
      expect(session.abort).toHaveBeenCalledOnce();
      expect(session.disconnect).toHaveBeenCalledOnce();
      expect(pool.release).toHaveBeenCalledExactlyOnceWith(handle);
      expect(session.sendAndWait).not.toHaveBeenCalled();
    } finally {
      ready.resolve(session);
      vi.useRealTimers();
    }
  });

  it("selects BYOK and uses the prepared model, credential, headers, and output limit", async () => {
    const { harness, createSession, sendAndWait } = isolatedFixture({
      content: "Done.",
      messageId: "message-1",
    });
    const params = {
      ...ISOLATED_COMPLETION_PARAMS,
      provider: "custom-openai",
      modelId: "prepared-model",
      authorization: {
        owner: "host",
        model: {
          ...ISOLATED_COMPLETION_PARAMS.authorization.model,
          id: "prepared-model",
          name: "Prepared model",
          provider: "custom-openai",
          baseUrl: "https://inference.example/v1",
          headers: { "x-tenant": "tenant-a" },
        },
        auth: {
          apiKey: "prepared-byok-key",
          profileId: "custom:work",
          source: "profile",
          mode: "api-key" as const,
        },
        sourceAuthFingerprint: "prepared-owner-fingerprint",
      },
      streamParams: { maxTokens: 321 },
    } satisfies AgentHarnessIsolatedCompletionParams;

    expect(
      harness.supports({
        provider: params.provider,
        modelId: params.modelId,
        modelProvider: params.authorization.model,
        providerOwnerStatus: "unowned",
        providerOwnerPluginIds: [],
        requestedRuntime: "copilot",
      }),
    ).toEqual({ supported: true, priority: 100 });

    await expect(harness.runIsolatedCompletionV2?.(params)).resolves.toEqual({
      assistant: expect.objectContaining({
        content: [{ type: "text", text: "Done." }],
        model: "prepared-model",
        provider: "custom-openai",
      }),
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "prepared-model",
        provider: expect.objectContaining({
          apiKey: "prepared-byok-key",
          baseUrl: "https://inference.example/v1",
          headers: { "x-tenant": "tenant-a" },
          maxOutputTokens: 321,
          modelId: "prepared-model",
          wireModel: "prepared-model",
        }),
      }),
    );
    expect(sendAndWait).toHaveBeenCalledWith(
      { prompt: params.prompt, requestHeaders: { "x-tenant": "tenant-a" } },
      expect.any(Number),
    );
    expect(sendAndWait.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(sendAndWait.mock.calls[0]?.[1]).toBeLessThanOrEqual(params.timeoutMs);
  });

  it("dispose before startup prevents pool creation", async () => {
    const harness = createCopilotAgentHarness();
    await harness.dispose?.();
    const attempt = harness.runAttempt(ATTEMPT_PARAMS);
    const disposal = harness.dispose?.();
    await expect(attempt).rejects.toThrow(
      "[copilot] harness has been disposed; cannot start new attempts",
    );
    await expect(disposal).resolves.toBeUndefined();
    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
    expect(mocks.runCopilotAttempt).not.toHaveBeenCalled();
  });

  it("finishes admitted lazy startup before disposing its pool", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotAttempt.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotAgentHarness();
    const attempt = harness.runAttempt(ATTEMPT_PARAMS);
    const disposal = harness.dispose?.();
    const settled = Promise.allSettled([attempt, disposal]);
    try {
      await Promise.race([started.promise, attempt]);
      expect(pool.dispose).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await settled;
    }
    await expect(attempt).resolves.toBe(ATTEMPT_RESULT);
    await expect(disposal).resolves.toBeUndefined();
    expect(pool.dispose).toHaveBeenCalledOnce();
  });

  it("dispose surfaces pool.dispose errors as AggregateError", async () => {
    const pool = makePoolMock();
    const errors = [new Error("first"), new Error("second")];
    pool.dispose = vi.fn().mockResolvedValue(errors);
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotAgentHarness();

    await harness.runAttempt(ATTEMPT_PARAMS);

    const disposal = harness.dispose?.();
    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    await expect(disposal).rejects.toMatchObject({
      message: "[copilot] pool disposal errors",
      errors,
    });
  });

  it("does not invoke deleteSession for a session belonging to a different openclawSessionId", async () => {
    const pool = makePoolMock();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const client = createMockCopilotClient({ deleteSession });
    mockEstablishedSession("sdk-sess-y", () => client);
    const harness = createCopilotAgentHarness({ pool });

    await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-A" });
    await harness.reset?.({ sessionId: "oc-B" });

    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("joins deferred binding deletion before disposal releases the pool", async () => {
    const sessionStore = makeSessionStoreMock();
    const deletion = createDeferred<void>();
    const admitted = createDeferred<void>();
    sessionStore.store.delete.mockImplementationOnce(async (key) => {
      admitted.resolve();
      await deletion.promise;
      return sessionStore.entries.delete(key);
    });
    const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
      await deps.onSessionEstablished?.({
        sdkSessionId: "sdk-sess-delayed-delete",
        pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
      });
      await deps.onDeferredCompaction?.({
        abort: () => cleanup.resolve("aborted"),
        cleanup: cleanup.promise,
        sdkSessionId: "sdk-sess-delayed-delete",
      });
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotAgentHarness({ sessionStore: sessionStore.store });
    await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-delayed-delete" });
    const disposal = harness.dispose?.();
    const repeatedDisposal = harness.dispose?.();
    await admitted.promise;
    await flushAsyncWork();
    expect(pool.dispose).not.toHaveBeenCalled();
    deletion.resolve();
    await disposal;
    await repeatedDisposal;
    expect(sessionStore.entries.has("oc-delayed-delete")).toBe(false);
    expect(pool.dispose).toHaveBeenCalledOnce();
  });

  it("does not reuse a reset target while deferred cleanup is pending", async () => {
    const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
    const abort = vi.fn();
    const replacementDeleteSession = vi.fn().mockResolvedValue(undefined);
    const duringResetDeleteSession = vi.fn().mockResolvedValue(undefined);
    const sessionStore = makeSessionStoreMock();
    let attempt = 0;
    mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
      attempt += 1;
      if (attempt === 1) {
        await deps.onSessionEstablished?.(established("sdk-sess-before-reset"));
        await deps.onDeferredCompaction?.({
          abort,
          cleanup: cleanup.promise,
          sdkSessionId: "sdk-sess-before-reset",
        });
      } else if (attempt === 2) {
        await deps.onSessionEstablished?.(
          established(
            "sdk-sess-replacement",
            createMockCopilotClient({ deleteSession: replacementDeleteSession }),
          ),
        );
      } else if (attempt === 3 && !params.initialReplayState?.sdkSessionId) {
        await deps.onSessionEstablished?.(
          established(
            "sdk-sess-during-reset",
            createMockCopilotClient({ deleteSession: duringResetDeleteSession }),
          ),
        );
      }
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotAgentHarness({
      pool: makePoolMock(),
      sessionStore: sessionStore.store,
    });
    const params = { ...ATTEMPT_PARAMS, sessionId: "oc-reset-reuse" };

    await harness.runAttempt(params);
    await harness.runAttempt(params);
    const reset = harness.reset?.({ sessionId: "oc-reset-reuse" });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    await harness.runAttempt(params);
    cleanup.resolve("aborted");
    await reset;

    expect(
      mocks.runCopilotAttempt.mock.calls[2]?.[0]?.initialReplayState?.sdkSessionId,
    ).toBeUndefined();
    expect(replacementDeleteSession).toHaveBeenCalledWith("sdk-sess-replacement");
    expect(duringResetDeleteSession).not.toHaveBeenCalled();
    expect(sessionStore.entries.get("oc-reset-reuse")?.sdkSessionId).toBe("sdk-sess-during-reset");
  });

  describe("session reuse across turns (dogfood finding #4)", () => {
    it("blocks reuse while timed-out compaction is pending, then resumes after completion", async () => {
      const pool = makePoolMock();
      const sessionStore = makeSessionStoreMock();
      const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
      let attempt = 0;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        attempt += 1;
        if (attempt === 1) {
          await deps.onSessionEstablished?.(established("sdk-sess-compacting"));
          await deps.onDeferredCompaction?.({
            abort: () => undefined,
            cleanup: cleanup.promise,
            sdkSessionId: "sdk-sess-compacting",
          });
        }
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool, sessionStore: sessionStore.store });

      await runTurn(harness, { runId: "t1" });
      await runTurn(harness, { runId: "t2" });

      expect(replayAt(1)?.sdkSessionId).toBeUndefined();

      await expect(harness.compact?.(makeAttemptParams())).resolves.toEqual(
        failedCompaction("background-compaction-pending"),
      );
      expect(pool.acquire).not.toHaveBeenCalled();

      cleanup.resolve("completed");
      await flushAsyncWork();

      await runTurn(harness, { runId: "t3" });
      expect(replayAt(2)?.sdkSessionId).toBe("sdk-sess-compacting");
      expect(sessionStore.store.delete).not.toHaveBeenCalledWith("oc-sess-reuse");
    });

    it("ignores deferred cleanup from a session replaced by an overlapping attempt", async () => {
      const firstAttemptFinished = createDeferred<void>();
      const staleCleanup = createDeferred<"aborted" | "completed" | "deadline">();
      let firstAttemptDeps: Pick<CopilotAttemptDeps, "onDeferredCompaction"> | undefined;
      let attempt = 0;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        attempt += 1;
        if (attempt === 1) {
          await deps.onSessionEstablished?.(established("sdk-sess-stale"));
          firstAttemptDeps = deps;
          await firstAttemptFinished.promise;
        } else if (attempt === 2) {
          await deps.onSessionEstablished?.(established("sdk-sess-current"));
        }
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });

      const firstAttempt = runTurn(harness, { runId: "t1" });
      await flushAsyncWork();
      await runTurn(harness, { runId: "t2" });
      void firstAttemptDeps?.onDeferredCompaction?.({
        abort: () => undefined,
        cleanup: staleCleanup.promise,
        sdkSessionId: "sdk-sess-stale",
      });
      firstAttemptFinished.resolve();
      await firstAttempt;

      await runTurn(harness, { runId: "t3" });

      expect(replayAt(2)?.sdkSessionId).toBe("sdk-sess-current");
      staleCleanup.resolve("completed");
      await flushAsyncWork();
    });

    it.each([
      {
        name: "resolved auth profile",
        before: { auth: undefined, authProfileId: "p1", resolvedApiKey: "tok-same" },
        after: { auth: undefined, authProfileId: "p2", resolvedApiKey: "tok-same" },
      },
      {
        name: "resolved token fingerprint",
        before: { auth: undefined, authProfileId: "p1", resolvedApiKey: "tok-a" },
        after: { auth: undefined, authProfileId: "p1", resolvedApiKey: "tok-b" },
      },
    ])("does not seed an SDK session after a $name change", async ({ before, after }) => {
      mockEstablishedSession("sdk-sess-before-change");
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });

      await runTurn(harness, { runId: "t1", ...before });
      await runTurn(harness, { runId: "t2", ...after });

      expect(replayAt(1)?.sdkSessionId).toBeUndefined();
    });

    it("reuses durable bindings across turns and restart, then resets despite SDK deletion failure", async () => {
      const { createPluginStateKeyedStoreForTests, resetPluginStateStoreForTests } =
        await import("openclaw/plugin-sdk/plugin-state-test-runtime");
      const { closeOpenClawStateDatabaseAsync } =
        await import("openclaw/plugin-sdk/sqlite-runtime-testing");
      const storeOptions = {
        namespace: "sdk-sessions",
        maxEntries: 5000,
        defaultTtlMs: 90 * 24 * 60 * 60 * 1000,
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("copilot-binding-") },
      };
      const openStore = () =>
        createPluginStateKeyedStoreForTests<CopilotSessionBinding>("copilot", storeOptions);
      const firstStore = openStore();
      let currentStore = firstStore;
      const deleteSession = vi.fn().mockRejectedValue(new Error("session not found"));
      const replay = { journalValidated: true, sdkSessionId: "sdk-sess-sqlite" };
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        await deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-sqlite",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient({ deleteSession }) },
        });
        expect((await currentStore.lookup("oc-sess-reuse"))?.journalVersion).toBeUndefined();
        return { ...ATTEMPT_RESULT, ...replay };
      });
      const firstPool = makePoolMock();
      mocks.createCopilotClientPool.mockReturnValue(firstPool);
      const firstHarness = createCopilotAgentHarness({ sessionStore: firstStore });
      expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
      try {
        await runTurn(firstHarness, { runId: "t1" });
        await runTurn(firstHarness, { runId: "t2" });
        expect(mocks.createCopilotClientPool).toHaveBeenCalledOnce();
        expect(mocks.runCopilotAttempt.mock.calls[0]?.[0]?.initialReplayState).toBeUndefined();
        expect(mocks.runCopilotAttempt.mock.calls[1]?.[0]?.initialReplayState).toEqual(replay);
        expect(await firstStore.lookup("oc-sess-reuse")).toMatchObject({
          schemaVersion: 2,
          journalVersion: 1,
          sdkSessionId: "sdk-sess-sqlite",
        });
        await firstHarness.dispose?.();
        expect(firstPool.dispose).toHaveBeenCalledOnce();
        await firstHarness.reset?.({ sessionId: "oc-sess-reuse" });
        expect(deleteSession).not.toHaveBeenCalled();
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
        const secondStore = openStore();
        currentStore = secondStore;
        const secondPool = makePoolMock();
        const secondHarness = createCopilotAgentHarness({
          pool: secondPool,
          sessionStore: secondStore,
        });
        await expect(secondHarness.compact?.(makeAttemptParams())).resolves.toEqual(
          failedCompaction("missing_thread_binding"),
        );
        expect(secondPool.acquire).not.toHaveBeenCalled();
        expect(await secondStore.lookup("oc-sess-reuse")).toMatchObject({
          sdkSessionId: "sdk-sess-sqlite",
        });
        await runTurn(secondHarness, { runId: "t3" });
        expect(mocks.runCopilotAttempt.mock.calls[2]?.[0]?.initialReplayState).toEqual(replay);
        await expect(
          secondHarness.reset?.({ sessionId: "oc-sess-reuse" }),
        ).resolves.toBeUndefined();
        await expect(
          secondHarness.reset?.({ sessionId: "oc-sess-reuse" }),
        ).resolves.toBeUndefined();
        expect(deleteSession).toHaveBeenCalledExactlyOnceWith("sdk-sess-sqlite");
        expect(await secondStore.lookup("oc-sess-reuse")).toBeUndefined();
        await secondHarness.dispose?.();
        expect(secondPool.dispose).not.toHaveBeenCalled();
      } finally {
        await firstHarness.dispose?.();
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
      }
    });

    it("persists BYOK session compatibility with endpoint fingerprints instead of raw URLs", async () => {
      const sessionStore = makeSessionStoreMock();
      mockEstablishedSession(
        "sdk-sess-byok",
        () => createMockCopilotClient({ deleteSession: vi.fn() }),
        TEST_SESSION_CONFIG,
      );
      const harness = storedHarness(sessionStore);

      await runTurn(harness, {
        provider: "custom-proxy",
        model: {
          provider: "custom-proxy",
          id: "proxy-model",
          api: "openai-responses",
          baseUrl: "https://proxy.example/v1?routing=blue",
        },
        auth: undefined,
        authProfileId: "custom-proxy:main",
        resolvedApiKey: "byok-token",
      });

      const stored = sessionStore.entries.get("oc-sess-reuse");
      expect(stored?.compatKey).toContain("baseUrlFingerprint=sha256:");
      expect(stored?.compatKey).not.toContain("proxy.example");
      expect(stored?.compatKey).not.toContain("routing=blue");
    });

    it("does not reuse BYOK sessions when attached request auth mode changes", async () => {
      const pool = makePoolMock();
      const model = {
        provider: "custom-proxy",
        id: "proxy-model",
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
      };
      mockEstablishedSession(
        "sdk-sess-byok",
        () => createMockCopilotClient({ deleteSession: vi.fn() }),
        TEST_SESSION_CONFIG,
      );
      const harness = createCopilotAgentHarness({ pool });
      const params = makeAttemptParams({
        provider: "custom-proxy",
        auth: undefined,
        authProfileId: "custom-proxy:main",
        resolvedApiKey: "byok-token",
      });

      await harness.runAttempt({
        ...params,
        model: attachModelProviderRequestTransport(model, { auth: { mode: "provider-default" } }),
      });
      await harness.runAttempt({
        ...params,
        runId: "t2",
        model: attachModelProviderRequestTransport(model, {
          auth: { mode: "header", headerName: "x-api-key", value: "byok-token" },
        }),
      });

      expect(replayAt(1)?.sdkSessionId).toBeUndefined();
    });

    it("resumes shipped schema v1 plugin-state bindings for attempts", async () => {
      const sessionStore = makeSessionStoreMock();
      mockEstablishedSession("sdk-sess-current");
      const firstHarness = storedHarness(sessionStore);

      await runTurn(firstHarness, { runId: "t1" });
      const stored = sessionStore.entries.get("oc-sess-reuse");
      if (!stored) {
        throw new Error("expected persisted binding");
      }
      sessionStore.entries.set("oc-sess-reuse", {
        schemaVersion: 1,
        sdkSessionId: "sdk-sess-v1",
        compatKey: stored.compatKey,
        updatedAt: Date.now(),
      } as never);
      mocks.runCopilotAttempt.mockClear();
      const secondHarness = storedHarness(sessionStore);

      await runTurn(secondHarness, { runId: "t2" });

      expect(replayAt(0)?.sdkSessionId).toBe("sdk-sess-v1");
    });

    it("starts a fresh SDK session when persisted binding lookup fails", async () => {
      const sessionStore = makeSessionStoreMock();
      sessionStore.store.lookup.mockImplementation(async () => {
        throw new Error("sqlite read failed");
      });
      mocks.runCopilotAttempt.mockResolvedValue(ATTEMPT_RESULT);
      const harness = storedHarness(sessionStore);

      await expect(runTurn(harness, { runId: "t1" })).resolves.toBe(ATTEMPT_RESULT);

      expect(replayAt(0)?.sdkSessionId).toBeUndefined();
      expect(sessionStore.store.delete).toHaveBeenCalledWith("oc-sess-reuse");
    });

    it("ignores a persisted sdkSessionId when the default Copilot home changes by agent id", async () => {
      const sessionStore = makeSessionStoreMock();
      mockEstablishedSession("sdk-sess-main-home");
      const firstHarness = storedHarness(sessionStore);
      const secondHarness = storedHarness(sessionStore);
      const defaultHomeParams = {
        agentDir: undefined,
        copilotHome: undefined,
      };

      await runTurn(firstHarness, {
        ...defaultHomeParams,
        runId: "t1",
        agentId: "main",
      });
      await runTurn(secondHarness, {
        ...defaultHomeParams,
        runId: "t2",
        agentId: "ops",
      });

      expect(replayAt(1)?.sdkSessionId).toBeUndefined();
    });

    it("does not let stale plugin state override a newer incompatible tracked session", async () => {
      const sessionStore = makeSessionStoreMock();
      mockEstablishedSession("sdk-sess-tracked-model");
      const harness = storedHarness(sessionStore);

      await runTurn(harness, { runId: "t1", model: { provider: "github-copilot", id: "gpt-4.1" } });
      const persisted = sessionStore.entries.get("oc-sess-reuse");
      expect(persisted).toBeDefined();

      await runTurn(harness, {
        runId: "t2",
        model: { provider: "github-copilot", id: "claude-sonnet-4.5" },
      });
      sessionStore.entries.set("oc-sess-reuse", persisted!);
      await runTurn(harness, { runId: "t3", model: { provider: "github-copilot", id: "gpt-4.1" } });

      expect(replayAt(2)?.sdkSessionId).toBeUndefined();
    });

    it("blocks persisted reuse after reset cannot delete a durable binding", async () => {
      const sessionStore = makeSessionStoreMock();
      mocks.runCopilotAttempt.mockImplementationOnce(async (_params, deps) => {
        await deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-before-reset",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const firstHarness = storedHarness(sessionStore);

      await runTurn(firstHarness, { runId: "t1" });
      expect(sessionStore.entries.get("oc-sess-reuse")?.sdkSessionId).toBe("sdk-sess-before-reset");
      sessionStore.store.delete.mockImplementation(async () => {
        throw new Error("sqlite delete failed");
      });
      mocks.runCopilotAttempt.mockResolvedValue(ATTEMPT_RESULT);
      const harness = storedHarness(sessionStore);

      await harness.reset?.({ sessionId: "oc-sess-reuse" });
      await runTurn(harness, { runId: "t2" });

      expect(replayAt(1)?.sdkSessionId).toBeUndefined();
    });
  });

  describe("compact", () => {
    it("returns ok:false when sessionId is missing", async () => {
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });
      const result = await harness.compact?.({
        workspaceDir: "/ws",
      } as AgentHarnessCompactParams);
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing-required-params",
      });
    });

    it("clears the reset block when storing a replacement session fails", async () => {
      const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
      const sessionStore = makeSessionStoreMock();
      sessionStore.store.register.mockImplementation(async () => {
        throw new Error("sqlite register failed");
      });
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        const sdkSessionId =
          mocks.runCopilotAttempt.mock.calls.length === 1
            ? "sdk-sess-background"
            : "sdk-sess-replacement";
        await deps.onSessionEstablished?.(established(sdkSessionId));
        if (sdkSessionId === "sdk-sess-background") {
          await deps.onDeferredCompaction?.({
            abort: () => undefined,
            cleanup: cleanup.promise,
            sdkSessionId,
          });
        }
        return ATTEMPT_RESULT;
      });
      const harness = storedHarness(sessionStore);
      const params = makeCompactParams({ sessionId: "oc-sess-store-failure" });

      await harness.runAttempt(params);
      await harness.runAttempt(params);
      await harness.runAttempt(params);

      expect(mocks.runCopilotAttempt.mock.calls[1]?.[0]).not.toMatchObject({
        initialReplayState: expect.objectContaining({ sdkSessionId: "sdk-sess-background" }),
      });
      expect(mocks.runCopilotAttempt.mock.calls[2]?.[0]).toMatchObject({
        initialReplayState: expect.objectContaining({ sdkSessionId: "sdk-sess-replacement" }),
      });
      cleanup.resolve("completed");
      await flushAsyncWork();
    });

    it("calls the SDK history compaction RPC without requiring a workspace sidecar", async () => {
      const beforeCompaction = vi.fn();
      const afterCompaction = vi.fn();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_compaction", handler: beforeCompaction },
          { hookName: "after_compaction", handler: afterCompaction },
        ]),
      );
      const compactResult = {
        success: true,
        tokensRemoved: 123,
        messagesRemoved: 4,
        summaryContent: "compacted summary",
        contextWindow: {
          tokenLimit: 1000,
          currentTokens: 777,
          messagesLength: 12,
        },
      };
      const { compact, disconnect, resumeSession } = compactSession(compactResult);
      disconnect.mockImplementation(async () => {
        throw new Error("disconnect failed");
      });
      const { pool, harness } = setupCompaction("sdk-sess-compact", resumeSession);

      const params = makeCompactParams({
        agentId: "main",
        sessionId: "oc-sess-compact-1",
        sessionKey: "agent:main:main",
      });
      await harness.runAttempt(params);
      const result = await harness.compact?.({
        ...params,
        model: "gpt-4.1",
        currentTokenCount: 900,
        workspaceDir: "/this\u0000is/illegal",
        customInstructions: "Keep decisions.",
      });

      expect(resumeSession).toHaveBeenCalledWith(
        "sdk-sess-compact",
        expect.objectContaining({
          availableTools: [],
          continuePendingWork: false,
          model: "gpt-4.1",
          suppressResumeEvent: true,
          tools: [],
          workingDirectory: "/workspace",
        }),
      );
      expect(compact).toHaveBeenCalledWith({ customInstructions: "Keep decisions." });
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(pool.release).toHaveBeenCalledTimes(1);
      expect(beforeCompaction).toHaveBeenCalledWith(
        { messageCount: -1, sessionFile: "/session.json" },
        expect.objectContaining({
          modelId: "gpt-4.1",
          modelProviderId: "github-copilot",
          sessionId: "oc-sess-compact-1",
          sessionKey: "agent:main:main",
        }),
      );
      expect(afterCompaction).toHaveBeenCalledWith(
        { compactedCount: 4, messageCount: -1, sessionFile: "/session.json" },
        expect.objectContaining({ sessionId: "oc-sess-compact-1" }),
      );
      expect(result).toEqual({
        ok: true,
        compacted: true,
        reason: "copilot-sdk-history-compacted",
        result: {
          summary: "compacted summary",
          firstKeptEntryId: "",
          tokensBefore: 900,
          tokensAfter: 777,
          details: compactResult,
          sessionId: "oc-sess-compact-1",
          sessionFile: "/session.json",
        },
      });
    });

    it("disconnects the resumed SDK session when compact aborts after resume", async () => {
      const abortController = new AbortController();
      const { compact, disconnect, resumeSession, session } = compactSession();
      resumeSession.mockImplementation(async () => {
        abortController.abort(new Error("stop compact"));
        return session;
      });
      const { pool, harness } = setupCompaction("sdk-sess-abort", resumeSession);

      const params = makeCompactParams({
        agentId: "main",
        sessionId: "oc-sess-abort",
        sessionKey: "agent:main:main",
      });
      await harness.runAttempt(params);
      const result = await harness.compact?.({
        ...params,
        abortSignal: abortController.signal,
        model: "gpt-4.1",
      });

      expect(resumeSession).toHaveBeenCalledTimes(1);
      expect(compact).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(pool.release).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        failedCompaction("copilot-sdk-history-compact-failed", "stop compact"),
      );
    });

    it("requires matching token auth before compacting a tracked token-auth SDK session", async () => {
      const { resumeSession } = compactSession();
      const { pool, harness } = setupCompaction("sdk-sess-token", resumeSession);
      const tokenAcquire = {
        auth: {
          agentId: "test",
          authMode: "gitHubToken",
          authProfileId: "p1",
          authProfileVersion: "v1",
          copilotHome: "/copilot-home",
          gitHubToken: "ghp_test",
        },
        key: { agentId: "test", authMode: "gitHubToken", copilotHome: "/copilot-home" },
        options: { copilotHome: "/copilot-home", gitHubToken: "ghp_test" },
        provider: { mode: "github-copilot" },
      } satisfies ReturnType<typeof resolvePoolAcquire>;
      mocks.resolvePoolAcquire
        .mockReturnValueOnce(tokenAcquire)
        .mockReturnValueOnce({
          auth: { agentId: "test", authMode: "useLoggedInUser", copilotHome: "/copilot-home" },
          key: { agentId: "test", authMode: "useLoggedInUser", copilotHome: "/copilot-home" },
          options: { copilotHome: "/copilot-home", useLoggedInUser: true },
          provider: { mode: "github-copilot" },
        })
        .mockReturnValueOnce(tokenAcquire);

      await harness.runAttempt(
        makeCompactParams({
          auth: { gitHubToken: "ghp_test", profileId: "p1", profileVersion: "v1" },
          sessionId: "oc-sess-token",
        }),
      );
      const result = await compactHarness(harness, {
        auth: undefined,
        sessionId: "oc-sess-token",
      });

      expect(pool.acquire).not.toHaveBeenCalled();
      expect(resumeSession).not.toHaveBeenCalled();
      expect(result).toEqual(failedCompaction("missing_thread_binding"));

      const matchingResult = await compactHarness(harness, {
        auth: undefined,
        authProfileId: "p1",
        resolvedApiKey: "ghp_test",
        sessionId: "oc-sess-token",
      });

      expect(resumeSession).toHaveBeenCalledWith(
        "sdk-sess-token",
        expect.objectContaining({ gitHubToken: "ghp_test" }),
      );
      expect(matchingResult?.compacted).toBe(true);
    });

    it("compacts tracked BYOK sessions from production compact params with a fresh proxy", async () => {
      const { resumeSession } = compactSession();
      const { harness } = setupCompaction("sdk-sess-byok", resumeSession);
      const trackedRuntimeModel = {
        provider: "local-proxy",
        id: "proxy-model",
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
      };
      const params = makeCompactParams({
        provider: "local-proxy",
        authProfileId: "byok:local-proxy",
        sessionId: "oc-sess-byok",
      });
      mocks.resolvePoolAcquire.mockImplementation((request: any) => {
        const runtimeModel = request.runtimeModel ?? request.model;
        if (!runtimeModel?.baseUrl) {
          throw new Error(COPILOT_BYOK_PROVIDER_ERROR);
        }
        return {
          auth: {
            agentId: "test",
            authMode: "byok",
            authProfileId: "byok:local-proxy",
            authProfileVersion:
              runtimeModel.baseUrl === trackedRuntimeModel.baseUrl
                ? "sha256:provider"
                : "sha256:rotated",
            copilotHome: "/copilot-home",
          },
          key: { agentId: "test", authMode: "byok", copilotHome: "/copilot-home" },
          options: { copilotHome: "/copilot-home" },
          provider: { mode: "byok" },
        };
      });
      const closeByokProxy = vi.fn(async () => undefined);
      mocks.createCopilotByokProxy.mockImplementation(async (provider: any) => ({
        close: closeByokProxy,
        provider: {
          ...provider,
          provider: {
            ...provider.provider,
            baseUrl: "http://127.0.0.1:49152/proxy/v1",
          },
        },
      }));
      const trackedProvider = {
        type: "openai" as const,
        wireApi: "responses" as const,
        baseUrl: "https://proxy.example/v1",
        modelId: "proxy-model",
        wireModel: "proxy-model",
      };
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        await deps.onSessionEstablished?.({
          compactionSessionConfig: {
            ...TEST_SESSION_CONFIG,
            provider: trackedProvider,
          },
          sdkSessionId: "sdk-sess-byok",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      await harness.runAttempt({
        ...params,
        model: trackedRuntimeModel,
        resolvedApiKey: "byok-token",
      });
      mocks.resolvePoolAcquire.mockClear();

      const rotatedResult = await harness.compact?.({
        ...params,
        model: "proxy-model",
        runtimeModel: {
          ...trackedRuntimeModel,
          baseUrl: "https://rotated.example/v1",
        },
      });

      expect(resumeSession).not.toHaveBeenCalled();
      expect(rotatedResult).toEqual(failedCompaction("missing_thread_binding"));
      mocks.resolvePoolAcquire.mockClear();

      const result = await harness.compact?.({
        ...params,
        model: "proxy-model",
        runtimeModel: trackedRuntimeModel,
      });

      expect(mocks.createCopilotByokProxy).toHaveBeenCalledWith({
        mode: "byok",
        provider: trackedProvider,
      });
      expect(resumeSession).toHaveBeenCalledWith(
        "sdk-sess-byok",
        expect.objectContaining({
          provider: expect.objectContaining({
            baseUrl: "http://127.0.0.1:49152/proxy/v1",
          }),
        }),
      );
      expect(closeByokProxy).toHaveBeenCalledTimes(1);
      expect(result?.compacted).toBe(true);
    });

    it.each([false, true])(
      "invalidates a stale SDK session unless a replacement was published (replacement=%s)",
      async (replacement) => {
        const sessionStore = makeSessionStoreMock();
        const resume = createDeferred<void>();
        const admitted = createDeferred<void>();
        const resumeSession = vi.fn(async () => {
          admitted.resolve();
          await resume.promise;
          throw new Error("session not found");
        });
        const pool = makePoolMock();
        pool.acquire = vi.fn(async () => ({
          key: TEST_POOL_KEY,
          client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
        }));
        pool.release = vi.fn(async () => undefined);
        let turn = 0;
        mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
          const sdkSessionId =
            replacement && turn++ > 0 ? "sdk-sess-replacement" : "sdk-sess-stale";
          await deps.onSessionEstablished?.(
            established(
              sdkSessionId,
              createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
            ),
          );
          return { ...ATTEMPT_RESULT, sdkSessionId, journalValidated: true };
        });
        const harness = createCopilotAgentHarness({ pool, sessionStore: sessionStore.store });
        const params = makeCompactParams({ sessionId: "oc-sess-stale" });
        await harness.runAttempt(params);
        const compaction = harness.compact?.(params);
        await admitted.promise;
        await harness.runAttempt(params);
        resume.resolve();
        const result = await compaction;
        expect(sessionStore.entries.get("oc-sess-stale")?.sdkSessionId).toBe(
          replacement ? "sdk-sess-replacement" : undefined,
        );
        expect(result).toEqual(failedCompaction("stale_thread_binding", "session not found"));
      },
    );

    it("aborts the SDK manual history compaction when the compact call is canceled", async () => {
      const abort = new AbortController();
      const pending = createDeferred<never>();
      const compact = vi.fn(() => pending.promise);
      const abortManualCompaction = vi.fn(async () => {
        pending.reject(new Error("manual compaction aborted"));
        return { aborted: true };
      });
      const disconnect = vi.fn(async () => undefined);
      const resumeSession = vi.fn(async () => ({
        disconnect,
        rpc: { history: { abortManualCompaction, compact } },
      }));
      const { harness } = setupCompaction("sdk-sess-cancel", resumeSession);

      await harness.runAttempt(makeCompactParams({ sessionId: "oc-sess-cancel" }));
      const resultPromise = compactHarness(harness, {
        abortSignal: abort.signal,
        sessionId: "oc-sess-cancel",
      });
      await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
      abort.abort(new Error("caller canceled"));
      const result = await resultPromise;

      expect(abortManualCompaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        failedCompaction("copilot-sdk-history-compact-failed", "caller canceled"),
      );
    });

    it("reports SDK history compaction no-ops without writing compatibility state", async () => {
      const { compact, resumeSession } = compactSession({
        success: true,
        tokensRemoved: 0,
        messagesRemoved: 0,
      });
      const { harness } = setupCompaction("sdk-sess-noop", resumeSession);

      await harness.runAttempt(makeCompactParams({ sessionId: "oc-sess-noop" }));
      const result = await harness.compact?.({
        ...makeCompactParams({ sessionId: "oc-sess-noop" }),
        workspaceDir: "/this\u0000is/illegal",
      });

      expect(compact).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({
        ok: true,
        compacted: false,
        reason: "already under target",
      });
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
