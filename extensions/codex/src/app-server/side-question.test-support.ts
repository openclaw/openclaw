import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  codexTestTurnIds,
  createFakeCodexAppServerClient,
} from "./codex-app-server.test-fixtures.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
import {
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

const readCodexAppServerBindingMock = vi.fn();
const isCodexAppServerNativeAuthProfileMock = vi.fn();
const getSharedCodexAppServerClientMock = vi.fn();
const refreshCodexAppServerAuthTokensMock = vi.fn();
const createOpenClawCodingToolsMock = vi.fn();
const toolExecuteMock = vi.fn();
const handleCodexAppServerApprovalRequestMock = vi.fn();
const resolveCodexProviderWebSearchSupportForClientMock = vi.fn();
type SelectionRetryParams = {
  lease: { client?: unknown };
  options: { timeoutMs?: number; abandonSignal?: AbortSignal };
  run: (
    client: unknown,
    requestOptions: () => { timeoutMs: number; signal?: AbortSignal; assertCurrent: () => void },
  ) => Promise<unknown>;
  onClientChange: (client: unknown) => void;
};
const withLeasedCodexAppServerClientStartSelectionRetryMock = vi.fn(
  async (params: SelectionRetryParams) =>
    await params.run(params.lease.client, () => ({
      timeoutMs: params.options.timeoutMs ?? 60_000,
      signal: params.options.abandonSignal,
      assertCurrent: () => {},
    })),
);

vi.mock("./auth-profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-profile.js")>()),
  isCodexAppServerNativeAuthProfile: (...args: unknown[]) =>
    isCodexAppServerNativeAuthProfileMock(...args),
}));

vi.mock("./shared-client.js", () => ({
  getSharedCodexAppServerClient: (...args: unknown[]) => getSharedCodexAppServerClientMock(...args),
  getLeasedSharedCodexAppServerClient: (...args: unknown[]) =>
    getSharedCodexAppServerClientMock(...args),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
  withLeasedCodexAppServerClientStartSelectionRetry: (params: SelectionRetryParams) =>
    withLeasedCodexAppServerClientStartSelectionRetryMock(params),
}));

vi.mock("./auth-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-bridge.js")>()),
  refreshCodexAppServerAuthTokens: (...args: unknown[]) =>
    refreshCodexAppServerAuthTokensMock(...args),
}));

vi.mock("./approval-bridge.js", () => ({
  handleCodexAppServerApprovalRequest: (...args: unknown[]) =>
    handleCodexAppServerApprovalRequestMock(...args),
}));

vi.mock("./provider-capabilities.js", () => ({
  resolveCodexProviderWebSearchSupportForClient: (...args: unknown[]) =>
    resolveCodexProviderWebSearchSupportForClientMock(...args),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  createOpenClawCodingTools: (...args: unknown[]) => createOpenClawCodingToolsMock(...args),
}));

const { runCodexAppServerSideQuestion: runCodexAppServerSideQuestionImpl } =
  await import("./side-question.js");
const baseBindingStore = createCodexTestBindingStore();
const bindingStore: CodexAppServerBindingStore = {
  ...baseBindingStore,
  read: (...args) => readCodexAppServerBindingMock(...args),
};

function runCodexAppServerSideQuestion(
  params: Parameters<typeof runCodexAppServerSideQuestionImpl>[0],
  options: Omit<Parameters<typeof runCodexAppServerSideQuestionImpl>[1], "bindingStore"> = {},
) {
  return runCodexAppServerSideQuestionImpl(params, { ...options, bindingStore });
}

function createFakeClient(options: { completeTurn?: boolean; onTurnStart?: () => void } = {}) {
  const fixture = createFakeCodexAppServerClient();
  const client = Object.assign(fixture.client, {
    notifications: fixture.notifications,
    request: fixture.request,
    requests: fixture.requests,
    emit: (notification: CodexServerNotification) => {
      void fixture.notify(notification);
    },
    handleRequest: (
      request: Parameters<typeof fixture.handleServerRequest>[0],
      signal?: AbortSignal,
    ) => fixture.handleServerRequest(request, signal),
    close: fixture.close,
  });
  client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
    if (method === "thread/read") {
      return threadResult(
        isJsonObject(requestParams) && typeof requestParams.threadId === "string"
          ? requestParams.threadId
          : "parent-thread",
      );
    }
    if (method === "thread/fork") {
      return threadResult("side-thread");
    }
    if (method === "thread/inject_items") {
      return {};
    }
    if (method === "turn/start") {
      options.onTurnStart?.();
      if (options.completeTurn !== false) {
        queueMicrotask(() => {
          client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
          client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        });
      }
      return turnStartResult("turn-1");
    }
    if (method === "turn/interrupt") {
      queueMicrotask(() => client.emit(turnCompleted("side-thread", "turn-1", "", "interrupted")));
      return {};
    }
    if (method === "thread/unsubscribe") {
      return {};
    }
    throw new Error(`unexpected request: ${method}`);
  });
  return client;
}

function threadResult(threadId: string) {
  return {
    thread: {
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp/workspace",
      projectId: null,
      cliVersion: "0.149.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.5",
    modelProvider: "openai",
    cwd: "/tmp/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
  };
}

function turnStartResult(turnId: string) {
  return {
    turn: {
      id: turnId,
      threadId: "side-thread",
      status: "inProgress",
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function agentDelta(threadId: string, turnId: string, delta: string): CodexServerNotification {
  return {
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "agent-1", delta },
  };
}

function turnCompleted(
  threadId: string,
  turnId: string,
  text: string,
  status: "completed" | "interrupted" = "completed",
): CodexServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        threadId,
        status,
        items: [{ id: "agent-1", type: "agentMessage", text }],
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  };
}

type SideQuestionParams = Parameters<typeof runCodexAppServerSideQuestion>[0];

const TEST_HOST_CAPABILITIES: SideQuestionParams["hostCapabilities"] = Object.freeze({
  kind: "agent-harness-host-capability",
  version: 1,
  assertActive: () => {},
  bindToolSurface: (tools) => tools,
  runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
  requestApproval: async () => undefined,
  waitForApproval: async () => undefined,
});

function sideParams(overrides: Partial<SideQuestionParams> = {}): SideQuestionParams {
  const authProfileId = Object.hasOwn(overrides, "authProfileId")
    ? overrides.authProfileId
    : "openai:work";
  const authProfileIdSource = Object.hasOwn(overrides, "authProfileIdSource")
    ? overrides.authProfileIdSource
    : "user";
  return {
    cfg: {} as never,
    agentDir: "/tmp/agent",
    provider: "openai",
    model: "gpt-5.5",
    question: "What changed?",
    sessionEntry: {
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      updatedAt: 1,
    },
    resolvedReasoningLevel: "off",
    opts: {},
    isNewSession: false,
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    authProfileId,
    authProfileIdSource,
    preparedRuntimeAuth: {
      plan: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: authProfileId,
        forwardedAuthProfileSource: authProfileId ? authProfileIdSource : undefined,
        forwardedAuthProfileCandidateIds: authProfileId ? [authProfileId] : undefined,
        selectedAuthMode: authProfileId ? "oauth" : undefined,
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.5",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      },
      authProfileStore: {
        version: 1,
        profiles: authProfileId
          ? {
              [authProfileId]: {
                type: "oauth",
                provider: "openai",
                access: "test-access-token",
                refresh: "test-refresh-token",
                expires: Date.now() + 24 * 60 * 60_000,
                accountId: "account-1",
              },
            }
          : {},
      },
      authStorage: {} as never,
      modelRegistry: {} as never,
    },
    ...overrides,
    hostCapabilities: overrides.hostCapabilities ?? TEST_HOST_CAPABILITIES,
  };
}

export function useSideQuestionTestSetup() {
  beforeEach(async () => {
    await nativeHookRelayTesting.clearNativeHookRelaysForTests();
    readCodexAppServerBindingMock.mockReset();
    isCodexAppServerNativeAuthProfileMock.mockReset();
    getSharedCodexAppServerClientMock.mockReset();
    refreshCodexAppServerAuthTokensMock.mockReset();
    createOpenClawCodingToolsMock.mockReset();
    toolExecuteMock.mockReset();
    handleCodexAppServerApprovalRequestMock.mockReset();
    resolveCodexProviderWebSearchSupportForClientMock.mockReset();
    withLeasedCodexAppServerClientStartSelectionRetryMock.mockReset();
    withLeasedCodexAppServerClientStartSelectionRetryMock.mockImplementation(
      async (params: SelectionRetryParams) =>
        await params.run(params.lease.client, () => ({
          timeoutMs: params.options.timeoutMs ?? 60_000,
          signal: params.options.abandonSignal,
          assertCurrent: () => {},
        })),
    );
    resolveCodexProviderWebSearchSupportForClientMock.mockResolvedValue("supported");

    toolExecuteMock.mockResolvedValue({
      content: [{ type: "text", text: "tool output" }],
    });
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "wiki_status",
        description: "Check wiki status",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute: toolExecuteMock,
      },
      {
        name: "web_search",
        description: "Search the web",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute: toolExecuteMock,
      },
    ]);

    readCodexAppServerBindingMock.mockReturnValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    isCodexAppServerNativeAuthProfileMock.mockReturnValue(true);
    getSharedCodexAppServerClientMock.mockResolvedValue(createFakeClient());
    refreshCodexAppServerAuthTokensMock.mockResolvedValue({
      accessToken: "access-token",
      chatgptAccountId: "account-1",
      chatgptPlanType: "plus",
    });
  });

  afterEach(async () => {
    await nativeHookRelayTesting.clearNativeHookRelaysForTests();
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}

export {
  readCodexAppServerBindingMock,
  isCodexAppServerNativeAuthProfileMock,
  getSharedCodexAppServerClientMock,
  refreshCodexAppServerAuthTokensMock,
  createOpenClawCodingToolsMock,
  toolExecuteMock,
  handleCodexAppServerApprovalRequestMock,
  resolveCodexProviderWebSearchSupportForClientMock,
  withLeasedCodexAppServerClientStartSelectionRetryMock,
  runCodexAppServerSideQuestion,
  runCodexAppServerSideQuestionImpl,
  createFakeClient,
  threadResult,
  turnStartResult,
  agentDelta,
  turnCompleted,
  sideParams,
  TEST_HOST_CAPABILITIES,
  type SelectionRetryParams,
};

export async function runSideQuestionWithManagedWebSearchCall(
  params: Parameters<typeof runCodexAppServerSideQuestion>[0] = sideParams(),
  options: {
    preserveToolFactory?: boolean;
    toolName?: string;
    toolArguments?: JsonObject;
  } = {},
) {
  const client = createFakeClient();
  let resolveTurnStarted!: () => void;
  const turnStarted = new Promise<void>((resolve) => {
    resolveTurnStarted = resolve;
  });
  if (!options.preserveToolFactory) {
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "web_search",
        description: "Search the web",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute: toolExecuteMock,
      },
    ]);
  }
  client.request.mockImplementation(async (method: string) => {
    if (method === "thread/fork") {
      return threadResult("side-thread");
    }
    if (method === "thread/inject_items") {
      return {};
    }
    if (method === "turn/start") {
      queueMicrotask(resolveTurnStarted);
      return turnStartResult("turn-1");
    }
    if (method === "thread/unsubscribe" || method === "turn/interrupt") {
      return {};
    }
    throw new Error(`unexpected request: ${method}`);
  });
  getSharedCodexAppServerClientMock.mockResolvedValue(client);

  const run = runCodexAppServerSideQuestion(params);
  await turnStarted;
  const toolResponse = await client.handleRequest({
    id: 42,
    method: "item/tool/call",
    params: {
      ...codexTestTurnIds("side-thread"),
      callId: "tool-1",
      tool: options.toolName ?? "web_search",
      arguments: options.toolArguments ?? { query: "service providers" },
    },
  });
  expect(toolResponse).not.toBeUndefined();
  client.emit(turnCompleted("side-thread", "turn-1", "Search answer."));
  const result = await run;
  const forkCall = client.request.mock.calls.find(([method]) => method === "thread/fork");
  const forkConfig = (forkCall?.[1] as { config?: Record<string, unknown> } | undefined)?.config;
  return { forkConfig, result, toolResponse };
}
