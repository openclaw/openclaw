import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
import { setHostToolFactoryForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  codexTestTurnIds,
  createFakeCodexAppServerClient,
  threadStartResult as nativeThreadStartResult,
  turnStartResult as nativeTurnStartResult,
} from "./codex-app-server.test-fixtures.js";
import {
  createCodexTestHostCapabilities,
  getCodexTestToolFactory,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
import {
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

const readCodexAppServerBindingMock = vi.fn();
const isCodexAppServerNativeAuthProfileMock = vi.fn();
const getSharedCodexAppServerClientMock = vi.fn();
const retireSharedCodexAppServerClientIfCurrentMock = vi.fn();
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
  retireSharedCodexAppServerClientIfCurrent: (...args: unknown[]) =>
    retireSharedCodexAppServerClientIfCurrentMock(...args),
  withLeasedCodexAppServerClientStartSelectionRetry: (params: SelectionRetryParams) =>
    withLeasedCodexAppServerClientStartSelectionRetryMock(params),
}));

vi.mock("./approval-bridge.js", () => ({
  handleCodexAppServerApprovalRequest: (...args: unknown[]) =>
    handleCodexAppServerApprovalRequestMock(...args),
}));

vi.mock("./provider-capabilities.js", () => ({
  resolveCodexProviderWebSearchSupportForClient: (...args: unknown[]) =>
    resolveCodexProviderWebSearchSupportForClientMock(...args),
}));

const { runCodexAppServerSideQuestion: runCodexAppServerSideQuestionImpl } =
  await import("./side-question.js");
const baseBindingStore = createCodexTestBindingStore();
const bindingStore: CodexAppServerBindingStore = {
  ...baseBindingStore,
  read: (...args) => readCodexAppServerBindingMock(...args),
};

async function runCodexAppServerSideQuestion(
  params: Parameters<typeof runCodexAppServerSideQuestionImpl>[0],
  options: Omit<Parameters<typeof runCodexAppServerSideQuestionImpl>[1], "bindingStore"> = {},
) {
  const runId = params.opts?.runId;
  if (runId && !getCodexTestToolFactory(params)) {
    await setHostToolFactoryForTest({ runId }, (toolOptions) =>
      createOpenClawCodingToolsMock(toolOptions),
    );
  }
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
    if (method === "thread/backgroundTerminals/list") {
      return { data: [] };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  return client;
}

export function sideLoopRelayParams(
  overrides: Partial<SideQuestionParams> = {},
): SideQuestionParams {
  return sideParams({
    cfg: { tools: { loopDetection: { enabled: true } } } as never,
    sessionKey: "agent:main:session-1",
    ...overrides,
  });
}

export function extractRelayIdFromThreadConfig(config: unknown): string {
  const record = config as Record<string, unknown> | undefined;
  let command: string | undefined;
  for (const key of [
    "hooks.PreToolUse",
    "hooks.PostToolUse",
    "hooks.PermissionRequest",
    "hooks.Stop",
  ]) {
    const entries = record?.[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries as Array<{ hooks?: Array<{ command?: string }> }>) {
      command = entry.hooks?.find((hook) => typeof hook.command === "string")?.command;
      if (command) {
        break;
      }
    }
    if (command) {
      break;
    }
  }
  const match = command?.match(/--relay-id ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay id missing from command: ${command}`);
  }
  return match[1];
}

function threadResult(threadId: string) {
  const { thread } = nativeThreadStartResult(threadId, "/tmp/workspace");
  return {
    thread: { ...thread, sessionId: threadId, ephemeral: true, cliVersion: "0.149.0" },
    model: "gpt-5.5",
    modelProvider: "openai",
    cwd: "/tmp/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
  };
}

function turnStartResult(turnId: string) {
  return { turn: { ...nativeTurnStartResult(turnId).turn, threadId: "side-thread" } };
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
        ...nativeTurnStartResult(turnId, status).turn,
        threadId,
        items: [{ id: "agent-1", type: "agentMessage", text }],
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

export function platformPreparedRuntimeAuth(resolvedApiKey?: string) {
  return {
    plan: {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      selectedAuthMode: "api-key",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.6",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    },
    authProfileStore: {
      version: 1 as const,
      profiles: {},
      order: { openai: [] },
    },
    authStorage: {} as never,
    modelRegistry: {} as never,
    ...(resolvedApiKey ? { resolvedApiKey } : {}),
  } satisfies Parameters<typeof runCodexAppServerSideQuestion>[0]["preparedRuntimeAuth"];
}

function sideParams(overrides: Partial<SideQuestionParams> = {}): SideQuestionParams {
  let hostCapabilities = overrides.hostCapabilities ?? TEST_HOST_CAPABILITIES;
  if (!hostCapabilities.createToolSurface) {
    hostCapabilities = createCodexTestHostCapabilities(hostCapabilities);
    setCodexTestToolFactory({ hostCapabilities }, createOpenClawCodingToolsMock);
  }
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
    hostCapabilities,
  };
}

export function useSideQuestionTestSetup() {
  beforeEach(async () => {
    await nativeHookRelayTesting.clearNativeHookRelaysForTests();
    readCodexAppServerBindingMock.mockReset();
    isCodexAppServerNativeAuthProfileMock.mockReset();
    getSharedCodexAppServerClientMock.mockReset();
    retireSharedCodexAppServerClientIfCurrentMock.mockReset();
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
  retireSharedCodexAppServerClientIfCurrentMock,
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
