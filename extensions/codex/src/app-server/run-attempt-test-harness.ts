import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  abortAndDrainAgentHarnessRun,
  nativeHookRelayTesting,
  queueAgentHarnessMessage,
  resetAgentEventsForTest,
  runBeforeToolCallHook,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { setHostToolFactoryForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { ExecApprovalsFile } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearInternalHooks, resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { clearPluginCommands } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createEmptyPluginRegistry,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { drainSessionDiskBudgetWorkers } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import { CodexAppServerClient } from "./client.js";
import {
  createCodexRequestRecorder,
  createFakeCodexAppServerClient,
  threadStartResult as createThreadStartResult,
  turnStartResult,
} from "./codex-app-server.test-fixtures.js";
import * as codexRequirements from "./config-requirements.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  createCodexTestHostCapabilities,
  getCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { CodexServerNotification, RpcRequest } from "./protocol.js";
import {
  cleanupRunSessionOwnersForTest,
  closeRunSessionOwnerDatabasesForTest,
  seedRunSessionOwnerForTest,
} from "./run-attempt-session-owners.test-support.js";
import { runCodexAppServerAttempt as runCodexAppServerAttemptImpl } from "./run-attempt.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import {
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory, CodexAppServerClientOptions } from "./shared-client.js";
import {
  adaptCodexTestClientFactory,
  createCodexTestModel,
  createCodexTestToolTerminalObserver,
  useAutoCleanupTempDirTracker,
  type CodexTestAppServerClientFactory,
} from "./test-support.js";
import { createCodexLifecycleTurnHarness } from "./thread-lifecycle.test-fixtures.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";
import { codexWorkspaceDirCache } from "./workspace-dir-cache.js";

export {
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
} from "./run-attempt-hook-test-support.js";

const execApprovalsRuntimeMocks = vi.hoisted(() => ({
  loadExecApprovals: vi.fn<() => ExecApprovalsFile>(() => ({ version: 1, agents: {} })),
}));

function createHarnessHostCapabilities(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams["hostCapabilities"] {
  return createCodexTestHostCapabilities({
    runBeforeToolCall: async ({ nativeOperation: _nativeOperation, approvalMode, ...request }) =>
      await runBeforeToolCallHook({
        ...request,
        approvalMode: approvalMode === "defer" ? "defer" : "request",
        ctx: Object.freeze({
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.config ? { config: params.config } : {}),
          ...(params.workspaceDir
            ? { cwd: params.workspaceDir, workspaceDir: params.workspaceDir }
            : {}),
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          runId: params.runId,
          trigger: params.trigger,
          approvalReviewerDeviceId: params.approvalReviewerDeviceId,
          turnSourceChannel: params.messageChannel ?? params.messageProvider,
          turnSourceTo: params.currentMessagingTarget ?? params.currentChannelId,
          turnSourceAccountId: params.agentAccountId,
          turnSourceThreadId: params.currentThreadTs,
        }),
      }),
  });
}

vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/exec-approvals-runtime")>();
  return {
    ...actual,
    loadExecApprovals: execApprovalsRuntimeMocks.loadExecApprovals,
  };
});

export let tempDir: string;
let codexAppServerClientFactoryForTest: CodexAppServerClientFactory | undefined;
const multiplexedTestClients = new WeakSet<CodexAppServerClient>();
export const fastWait = { interval: 1, timeout: 5_000 } as const;
const activeAppServerAttemptsForTest = new Set<{
  abortController?: AbortController;
  promise: Promise<unknown>;
  sessionId: string;
  sessionKey?: string;
}>();
const activeHarnessHostClosuresForTest = new Set<() => void>();

type RunCodexAppServerAttemptOptions = Omit<
  NonNullable<Parameters<typeof runCodexAppServerAttemptImpl>[1]>,
  "bindingStore"
> & {
  bindingStore?: NonNullable<Parameters<typeof runCodexAppServerAttemptImpl>[1]>["bindingStore"];
};

export function queueActiveRunMessageForTest(
  ...args: Parameters<typeof queueAgentHarnessMessage>
): boolean {
  return queueAgentHarnessMessage(...args);
}

export function setCodexAppServerClientFactoryForTest(
  factory: CodexTestAppServerClientFactory,
): void {
  codexAppServerClientFactoryForTest = adaptCodexTestClientFactory(async (...args) => {
    const client = await factory(...args);
    const testClient = client as unknown as {
      addCloseHandler?: (handler: (client: CodexAppServerClient) => void) => () => void;
    };
    // Narrow test doubles still need the client lifecycle hook installed by
    // the keyed router, even when the test never simulates transport closure.
    testClient.addCloseHandler ??= () => () => undefined;
    if (!(client instanceof CodexAppServerClient)) {
      multiplexCodexTestClientHandlers(client);
    }
    return client;
  });
}

// The keyed router, client runtime, and subagent monitor each register their
// own handlers; single-slot test doubles would silently drop all but the last.
export function multiplexCodexTestClientHandlers(client: CodexAppServerClient): void {
  if (multiplexedTestClients.has(client)) {
    return;
  }
  multiplexedTestClients.add(client);
  const notificationHandlers = new Set<
    Parameters<CodexAppServerClient["addNotificationHandler"]>[0]
  >();
  const requestHandlers = new Set<Parameters<CodexAppServerClient["addRequestHandler"]>[0]>();
  const addNotificationHandler = client.addNotificationHandler.bind(client);
  const addRequestHandler = client.addRequestHandler.bind(client);
  addNotificationHandler(async (notification) => {
    await Promise.all(
      [...notificationHandlers].map((handler) => Promise.resolve(handler(notification))),
    );
  });
  addRequestHandler(async (request) => {
    for (const handler of requestHandlers) {
      const result = await handler(request);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  });
  client.addNotificationHandler = (handler) => {
    notificationHandlers.add(handler);
    return () => notificationHandlers.delete(handler);
  };
  client.addRequestHandler = (handler) => {
    requestHandlers.add(handler);
    return () => requestHandlers.delete(handler);
  };
}

function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientFactoryForTest = undefined;
}

export function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: RunCodexAppServerAttemptOptions = {},
) {
  const turnAccepted = createDeferred<void>();
  registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
  const clientFactory = options.clientFactory ?? codexAppServerClientFactoryForTest;
  const abortController = params.abortSignal ? undefined : new AbortController();
  const trackedParams = abortController
    ? ({ ...params, abortSignal: abortController.signal } as EmbeddedRunAttemptParams)
    : params;
  const entry = {
    abortController,
    promise: undefined as unknown as Promise<unknown>,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  };
  const onExecutionPhase = trackedParams.onExecutionPhase;
  const observeExecutionPhase: NonNullable<EmbeddedRunAttemptParams["onExecutionPhase"]> = (
    event,
  ) => {
    onExecutionPhase?.call(trackedParams, event);
    if (event.phase === "turn_accepted") {
      turnAccepted.resolve();
    }
  };
  trackedParams.onExecutionPhase = observeExecutionPhase;
  const promise = runCodexAppServerAttemptImpl(trackedParams, {
    ...options,
    startupTimeoutFloorMs: options.startupTimeoutFloorMs ?? 30_000,
    bindingStore: options.bindingStore ?? testCodexAppServerBindingStore,
    ...(clientFactory ? { clientFactory } : {}),
  }).finally(() => {
    if (trackedParams.onExecutionPhase === observeExecutionPhase) {
      trackedParams.onExecutionPhase = onExecutionPhase;
    }
    activeAppServerAttemptsForTest.delete(entry);
  });
  entry.promise = promise;
  activeAppServerAttemptsForTest.add(entry);
  promise.catch(() => undefined);
  return Object.assign(promise, {
    // Observing turn/start only proves dispatch; lifecycle actions need acceptance.
    waitForTurnAccepted: () =>
      Promise.race([
        turnAccepted.promise,
        promise.then(() => {
          throw new Error("Codex attempt settled before turn acceptance");
        }),
      ]),
  });
}

async function drainActiveAppServerAttemptsForTest(): Promise<boolean> {
  vi.useRealTimers();
  const attempts = [...activeAppServerAttemptsForTest];
  if (attempts.length === 0) {
    return true;
  }
  for (const attempt of attempts) {
    attempt.abortController?.abort("test_cleanup");
  }
  const drainedSessions = new Set<string>();
  const sessionDrains = attempts.flatMap((attempt) => {
    if (!attempt.sessionId || drainedSessions.has(attempt.sessionId)) {
      return [];
    }
    drainedSessions.add(attempt.sessionId);
    return [
      abortAndDrainAgentHarnessRun({
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        settleMs: 1_000,
        forceClear: true,
        reason: "test_cleanup",
      }).catch(() => undefined),
    ];
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const drainResult = await Promise.race([
      Promise.allSettled([...attempts.map((attempt) => attempt.promise), ...sessionDrains]).then(
        () => "settled" as const,
      ),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 5_000);
      }),
    ]);
    if (drainResult === "settled") {
      activeAppServerAttemptsForTest.clear();
      return true;
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function createParams(
  sessionFile: string,
  workspaceDir: string,
  identity: {
    prompt?: string;
    provider?: string;
    runId?: string;
    sessionId?: string;
    sessionKey?: string;
  } = {},
): EmbeddedRunAttemptParams {
  const sessionId = identity.sessionId ?? "session-1";
  const sessionKey = identity.sessionKey ?? "agent:main:session-1";
  const provider = identity.provider ?? "codex";
  const model = createCodexTestModel(provider);
  const params = {
    prompt: identity.prompt ?? "hello",
    sessionId,
    sessionKey,
    sessionFile,
    workspaceDir,
    runId: identity.runId ?? "run-1",
    provider,
    modelId: "gpt-5.4-codex",
    model: {
      ...model,
      compat: { ...model.compat, supportsTools: false },
    } as EmbeddedRunAttemptParams["model"] & { compat: { supportsTools: boolean } },
    contextTokenBudget: 150_000,
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "agentContextTokens",
    },
    thinkLevel: "medium",
    disableTools: false,
    config: { tools: { web: { search: { enabled: false } } } },
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    observeToolTerminal: createCodexTestToolTerminalObserver(),
  } as unknown as EmbeddedRunAttemptParams;
  params.hostCapabilities = createHarnessHostCapabilities(params);
  return params;
}

export function createTestParams(): EmbeddedRunAttemptParams {
  return createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace"));
}

export function createNativeRunParams(
  sessionFile: string,
  workspaceDir: string,
  sessionKey = "agent:main:session-1",
): EmbeddedRunAttemptParams {
  const params = createParams(sessionFile, workspaceDir, { sessionKey });
  params.disableTools = true;
  params.config = undefined;
  delete params.contextTokenBudget;
  delete params.contextWindowInfo;
  delete params.observeToolTerminal;
  return params;
}

/** Replaces the lightweight default with the admitted host boundary used in production. */
export async function bindProductionHarnessHostCapabilitiesForTest(
  params: EmbeddedRunAttemptParams,
  operatorSource?: Parameters<
    typeof createAgentHarnessHostCapabilitiesForTest
  >[0]["operatorSource"],
): Promise<() => void> {
  const factory = getCodexTestToolFactory(params);
  if (factory) {
    await setHostToolFactoryForTest(params, factory);
  }
  const { hostCapabilities: _hostCapabilities, ...attempt } = params;
  const host = await createAgentHarnessHostCapabilitiesForTest({
    attempt,
    pluginId: "codex",
    nativeModelPolicySupport: "exact",
    operatorSource,
  });
  params.hostCapabilities = host.capabilities;
  let active = true;
  const close = () => {
    if (!active) {
      return;
    }
    active = false;
    activeHarnessHostClosuresForTest.delete(close);
    host.close();
  };
  activeHarnessHostClosuresForTest.add(close);
  return close;
}

export {
  setCodexTestModelSupportsTools,
  createCodexRuntimePlanFixture,
} from "./thread-lifecycle.test-fixtures.js";

export function assistantMessage(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-chatgpt-responses",
    provider: "openai",
    model: "gpt-5.4-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}

export function userMessage(text: string, timestamp: number) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp,
  };
}

export function mockCall(mock: unknown, label: string, index = 0): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.at(index);
  if (!call) {
    throw new Error(`Expected ${label} call ${index + 1}`);
  }
  return call;
}

export function getMockRuntimeIdentity() {
  return { serverVersion: CODEX_APP_SERVER_VERSION };
}

export { mockClientRuntimeMethods, turnStartResult } from "./codex-app-server.test-fixtures.js";

export function threadStartResult(threadId = "thread-1", options: { cwd?: string } = {}) {
  const cwd = options.cwd ?? tempDir ?? "/tmp/openclaw-codex-test";
  return createThreadStartResult(threadId, cwd);
}

export function createThreadStartRequest(threadId = "thread-1") {
  const responses: Record<string, unknown> = {
    "configRequirements/read": { requirements: null },
    "config/read": { config: {}, origins: {}, layers: [] },
    "thread/start": threadStartResult(threadId),
  };
  return vi.fn(async (method: string, _params?: unknown) => {
    if (!Object.hasOwn(responses, method)) {
      throw new Error(`unexpected method: ${method}`);
    }
    return responses[method];
  });
}

export function rateLimitsUpdated(resetsAt: number): CodexServerNotification {
  return {
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "rate_limit_reached",
      },
    },
  };
}

export function createAppServerHarness(
  requestImpl: (
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>,
  options: {
    persistedThreads?: string[];
    onStart?: (
      authProfileId: string | undefined,
      agentDir: string | undefined,
      options: CodexAppServerClientOptions | undefined,
    ) => void;
  } = {},
) {
  if (options.persistedThreads) {
    const harness = createCodexLifecycleTurnHarness({
      respond: requestImpl,
      persistedThreads: options.persistedThreads,
      agentDir: path.join(tempDir, "wire-agent"),
    });
    setCodexAppServerClientFactoryForTest(
      async (_start, auth, agentDir, _config, clientOptions) => {
        options.onStart?.(auth, agentDir, clientOptions);
        return await harness.acquire(clientOptions);
      },
    );
    return harness;
  }
  const { requests, record, waitForMethod } = createCodexRequestRecorder();
  const fixture = createFakeCodexAppServerClient(async (method, params, requestOptions) => {
    record(method, params);
    const result = await requestImpl(
      method,
      params,
      requestOptions as { signal?: AbortSignal } | undefined,
    );
    if (method === "turn/interrupt") {
      const { threadId, turnId } = params as { threadId?: string; turnId?: string };
      if (threadId && turnId) {
        // Codex publishes this terminal after acknowledging interruption.
        queueMicrotask(() => {
          void fixture.notify({
            method: "turn/completed",
            params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } },
          });
        });
      }
    }
    return result;
  });
  const { client, request } = fixture;
  let closed = false;
  const close = (error?: Error) => {
    if (!closed) {
      closed = true;
      fixture.close(error);
    }
  };
  client.close = () => close(new Error("codex app-server client is closed"));
  client.closeAndWait = async () => {
    client.close();
    return { exited: true, cleanup: "closed" };
  };
  setCodexAppServerClientFactoryForTest(
    async (_startOptions, authProfileId, agentDir, _config, clientOptions) => {
      options.onStart?.(authProfileId, agentDir, clientOptions);
      return client;
    },
  );

  const waitForServerRequestHandler = async () => {
    await fixture.requestHandlerReady;
    return fixture.handleServerRequest;
  };

  const sendNotification = async (notification: CodexServerNotification) => {
    // Keep dispatch synchronous once attached: terminal-then-close order is observable.
    if (fixture.notifications.size === 0) {
      await fixture.notificationHandlerReady;
    }
    await fixture.notify(notification);
  };

  return {
    client,
    request,
    requests,
    waitForMethod,
    notify: sendNotification,
    waitForServerRequestHandler,
    handleServerRequest: async (requestLocal: RpcRequest) => {
      const handler = await waitForServerRequestHandler();
      return handler(requestLocal);
    },
    completeTurn: async (params: { threadId: string; turnId: string }) => {
      await sendNotification({
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          turn: { id: params.turnId, status: "completed", items: [] },
        },
      });
    },
    close,
  };
}

function defaultAttemptHarnessResponse(method: string) {
  if (method === "configRequirements/read") {
    return { requirements: null };
  }
  if (method === "config/read") {
    return { config: {}, origins: {}, layers: [] };
  }
  if (method === "turn/start") {
    return turnStartResult();
  }
  if (method === "thread/backgroundTerminals/list") {
    return { data: [], nextCursor: null };
  }
  return {};
}

export function createStartedThreadHarness(
  requestImpl: Parameters<typeof createAppServerHarness>[0] = async () => undefined,
  options: Parameters<typeof createAppServerHarness>[1] = {},
) {
  return createAppServerHarness(async (method, params, requestOptions) => {
    const override = await requestImpl(method, params, requestOptions);
    if (override !== undefined) {
      return override;
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    return defaultAttemptHarnessResponse(method);
  }, options);
}

export function createResumeHarness(
  threadId = "thread-existing",
  requestImpl: Parameters<typeof createAppServerHarness>[0] = async () => undefined,
) {
  return createAppServerHarness(
    async (method, params, requestOptions) => {
      const override = await requestImpl(method, params, requestOptions);
      if (override !== undefined) {
        return override;
      }
      if (method === "thread/resume") {
        // Resume must echo the requested thread; a different id is rejected as
        // an unsafe subscription.
        const resumeParams = params as { threadId?: string; modelProvider?: string };
        return {
          ...threadStartResult(resumeParams.threadId ?? "thread-existing"),
          ...(resumeParams.modelProvider ? { modelProvider: resumeParams.modelProvider } : {}),
        };
      }
      return defaultAttemptHarnessResponse(method);
    },
    { persistedThreads: [threadId] },
  );
}

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

export function createRuntimeDynamicTool(name: string): RuntimeDynamicToolForTest {
  return {
    name,
    label: name,
    description: name + " test tool",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: name + " done" }],
      details: {},
    })),
  };
}

export function setupRunAttemptTestHooks(): void {
  // Keep unique test roots alive while the suite reuses native database workers.
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await cleanupRunSessionOwnersForTest();
      await closeRunSessionOwnerDatabasesForTest();
      await drainSessionDiskBudgetWorkers();
      cleanup();
    }),
  );

  beforeEach(async () => {
    // Direct runtime tests supply the plugin root normally owned by loader registration.
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    // Machine-managed sandbox requirements must not leak into policy fixtures.
    vi.spyOn(codexRequirements, "readCodexRequirementsToml").mockReturnValue(undefined);
    // An uninitialized real host approvals store intentionally fails closed.
    execApprovalsRuntimeMocks.loadExecApprovals.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({ version: 1, agents: {} });
    defaultCodexAppInventoryCache.clear();
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.useRealTimers();
    clearInternalHooks();
    clearMemoryPluginState();
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
    vi.stubEnv("OPENCLAW_TRAJECTORY", "0");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    tempDir = tempDirs.make("openclaw-codex-run-", resolvePreferredOpenClawTmpDir());
    // createParams models an ordinary durable session; seeded native bindings
    // must have the same authoritative core owner as a real resumed conversation.
    await seedRunSessionOwnerForTest("session-1", "agent:main:session-1");
  });

  afterEach(async () => {
    const drained = await drainActiveAppServerAttemptsForTest();
    for (const close of activeHarnessHostClosuresForTest) {
      close();
    }
    await sandboxExecServerRegistry.closeAll();
    await nativeHookRelayUnregisterQueue.clear();
    await nativeHookRelayTesting.clearNativeHookRelaysForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Registry retirement can access session storage, so join it before deleting test rows.
    const registry = getActivePluginRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const pluginCleanup = registry ? await disposePluginRegistryInstances(registry) : undefined;
    // A run beyond the drain deadline still needs the original database revocation fence.
    await cleanupRunSessionOwnersForTest({ closeDatabases: !drained });
    resetCodexAppServerClientFactoryForTest();
    setManagedCodexPluginRoot(undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    codexWorkspaceDirCache.clear();
    clearMemoryPluginState();
    clearPluginCommands();
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    clearInternalHooks();
    defaultCodexAppInventoryCache.clear();
    defaultCodexPluginMetadataCache.clear();
    vi.unstubAllEnvs();
    if (pluginCleanup) {
      expect(pluginCleanup.failures).toEqual([]);
    }
  });
}
