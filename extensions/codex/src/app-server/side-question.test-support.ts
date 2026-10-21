import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { setHostToolFactoryForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordCodexThreadForkSettings,
  recordCodexTurnForkSettings,
} from "./client-fork-settings.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
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
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type CodexThreadStartParams,
  type CodexTurnStartParams,
} from "./protocol.js";
import {
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

export function registerSideQuestionForkTests() {
  async function createDeniedSideQuestion(options: Parameters<typeof createFakeClient>[0] = {}) {
    const host = await createAdmittedHostCapabilityTestFixture(
      { runId: "run-side-1" },
      { toolCalls: "deny" },
    );
    const client = createFakeClient(options);
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) =>
      method === "configRequirements/read" ? { requirements: null } : baseRequest(method, params),
    );
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    return {
      client,
      start: () =>
        runCodexAppServerSideQuestion(
          sideParams({
            toolCalls: "deny",
            hostCapabilities: host.hostCapabilities,
            opts: { runId: "run-side-1" },
          }),
          { nativeHookRelay: { enabled: true } },
        ),
      [Symbol.dispose]() {
        client.close();
        host.closeHost();
        host.closeAdmission();
      },
    };
  }

  describe("runCodexAppServerSideQuestion cache-parity fork", () => {
    useSideQuestionTestSetup();
    it("denies tools while preserving parent settings and disabling inherited search", async () => {
      const webSearch = "live";
      const agentEnd = vi.fn();
      const beforeFinalize = vi.fn();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "agent_end", handler: agentEnd },
          { hookName: "before_agent_finalize", handler: beforeFinalize },
        ]),
      );
      const turnStarted = createDeferred<void>();
      using fixture = await createDeniedSideQuestion({
        completeTurn: false,
        onTurnStart: () => turnStarted.resolve(),
      });
      const { client, start } = fixture;
      const parentPolicy = {
        model: "gpt-5.5",
        cwd: "/tmp/parent-workspace",
        runtimeWorkspaceRoots: ["/tmp/parent-root"],
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        serviceTier: "priority",
      } satisfies CodexThreadStartParams;
      const parentThread: CodexThreadStartParams = {
        ...parentPolicy,
        modelProvider: "openai",
        permissions: "parent-permissions",
        developerInstructions: "Exact parent generic policy and workspace instructions.",
        config: {
          web_search: webSearch,
          "features.code_mode": false,
          "features.computer_use": true,
          "features.custom_parent_feature": true,
        },
      };
      const parentTurn: CodexTurnStartParams = {
        ...parentPolicy,
        threadId: "parent-thread",
        input: [],
        sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
        effort: "high",
        personality: "none",
        environments: [{ environmentId: "exact-parent-environment", cwd: "/workspace" }],
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.5",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
        additionalContext: {
          parent_context: { kind: "application", value: "Unchanged parent context" },
        },
      };
      recordCodexThreadForkSettings(client, "parent-thread", parentThread);
      recordCodexTurnForkSettings(client, parentTurn);
      const baseRequest = client.request.getMockImplementation()!;
      client.request.mockImplementation(async (method, requestParams) => {
        if (method === "thread/fork") {
          if (!isJsonObject(requestParams) || !isJsonObject(requestParams.config)) {
            throw new Error("Expected fork config");
          }
          const config = requestParams.config;
          expect(requestParams).toMatchObject({
            ...parentThread,
            config: { ...parentThread.config, web_search: "disabled" },
            ephemeral: true,
            excludeTurns: true,
            threadId: "parent-thread",
          });
          expect(requestParams).not.toHaveProperty("dynamicTools");
          for (const [key, value] of Object.entries(config)) {
            if (!key.startsWith("hooks.") && key !== "features.hooks" && key !== "web_search") {
              expect(parentThread.config?.[key]).toEqual(value);
            }
          }
          expect(config["hooks.Stop"]).toEqual([]);
          expect(parentThread.config?.web_search).toBe(webSearch);
          const response = await invokeSidePreToolUse(
            config,
            "denied-native",
            "touch /tmp/never-executed",
          );
          expect(response.stdout).toContain("Tool calls are denied");
        }
        if (method === "turn/start") {
          expect(requestParams).toEqual({
            ...parentTurn,
            threadId: "side-thread",
            input: [{ type: "text", text: "What changed?", text_elements: [] }],
          });
        }
        return baseRequest(method, requestParams);
      });
      const run = start();
      try {
        await Promise.race([
          turnStarted.promise,
          run.then(() => {
            throw new Error("Side question finished before starting its turn");
          }),
        ]);
        await expect(
          client.handleRequest({
            id: "denied-dynamic",
            method: "item/tool/call",
            params: {
              ...codexTestTurnIds("side-thread"),
              callId: "tool-1",
              tool: "wiki_status",
              arguments: {},
            },
          }),
        ).resolves.toMatchObject({ success: false });
        expect(toolExecuteMock).not.toHaveBeenCalled();
        client.emit(turnCompleted("side-thread", "turn-1", "Read-only review."));
        await expect(run).resolves.toEqual({ text: "Read-only review." });
        expect(agentEnd).not.toHaveBeenCalled();
        expect(beforeFinalize).not.toHaveBeenCalled();
        expect(client.request.mock.calls.some(([method]) => method === "thread/inject_items")).toBe(
          false,
        );
      } finally {
        client.emit(turnCompleted("side-thread", "turn-1", "Read-only review."));
        await run.catch(() => undefined);
      }
    });

    it.each(["settled", "thread-replaced", "client-replaced"])(
      "checks physical parent ownership after admission: %s",
      async (change) => {
        using fixture = await createDeniedSideQuestion();
        const { client, start } = fixture;
        recordCodexThreadForkSettings(client, "parent-thread", { model: "gpt-5.5" });
        recordCodexTurnForkSettings(client, { threadId: "parent-thread", input: [] });
        const binding = {
          ...readCodexAppServerBindingMock(),
          clientId: client.getInstanceId(),
          updatedAt: "2026-10-01T00:00:00.000Z",
        };
        readCodexAppServerBindingMock.mockReturnValue(binding);
        getSharedCodexAppServerClientMock.mockImplementation(async () => {
          readCodexAppServerBindingMock.mockReturnValue({
            ...binding,
            updatedAt: "2026-10-01T00:00:01.000Z",
            ...(change === "thread-replaced" ? { threadId: "replacement-thread" } : {}),
            ...(change === "client-replaced" ? { clientId: "replacement-client" } : {}),
          });
          return client;
        });
        const run = start();
        if (change === "settled") {
          await expect(run).resolves.toMatchObject({ text: "Side answer." });
        } else {
          await expect(run).rejects.toThrow("Codex side-question binding changed before fork");
          expect(client.request.mock.calls.some(([method]) => method === "thread/fork")).toBe(
            false,
          );
        }
      },
    );

    it.each([undefined, { enabled: false }])(
      "fails closed without native tool denial relay (%j)",
      async (nativeHookRelay) => {
        await expect(
          runCodexAppServerSideQuestion(sideParams({ toolCalls: "deny" }), { nativeHookRelay }),
        ).rejects.toThrow("tool denial requires the Codex native hook relay");
        expect(toolExecuteMock).not.toHaveBeenCalled();
      },
    );
  });
}

export function codexHookCommand(config: unknown, key: string) {
  const entries = (config as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(entries)) {
    return undefined;
  }
  return (
    entries as Array<{ hooks?: Array<{ command?: string; timeout?: number; type?: string }> }>
  )
    .at(0)
    ?.hooks?.at(0);
}

export function invokeSidePreToolUse(config: unknown, toolUseId: string, command: string) {
  return invokeNativeHookRelay({
    provider: "codex",
    relayId: extractRelayIdFromThreadConfig(config),
    generation: codexHookCommand(config, "hooks.PreToolUse")?.command?.match(
      /--generation ([^ ]+)/,
    )?.[1],
    requireGeneration: true,
    event: "pre_tool_use",
    rawPayload: {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: { command },
    },
  });
}
export const readCodexAppServerBindingMock = vi.fn();
export const isCodexAppServerNativeAuthProfileMock = vi.fn();
export const getSharedCodexAppServerClientMock = vi.fn();
export const retireSharedCodexAppServerClientIfCurrentMock = vi.fn();
export const createOpenClawCodingToolsMock = vi.fn();
export const toolExecuteMock = vi.fn();
export const handleCodexAppServerApprovalRequestMock = vi.fn();
export const resolveCodexProviderWebSearchSupportForClientMock = vi.fn();
type RequestScopeParams = {
  lease: { client?: unknown };
  options: { timeoutMs?: number; abandonSignal?: AbortSignal };
  signal?: AbortSignal;
  run: (
    client: unknown,
    requestOptions: () => { timeoutMs: number; signal?: AbortSignal },
  ) => Promise<unknown>;
};
async function runRequestScope(params: RequestScopeParams) {
  return await params.run(params.lease.client, () => ({
    timeoutMs: params.options.timeoutMs ?? 60_000,
    signal: params.signal ?? params.options.abandonSignal,
  }));
}
const withCodexAppServerClientRequestScopeMock = vi.fn(runRequestScope);

vi.mock("./auth-profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-profile.js")>()),
  isCodexAppServerNativeAuthProfile: (...args: unknown[]) =>
    isCodexAppServerNativeAuthProfileMock(...args),
}));

vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  getSharedCodexAppServerClient: (...args: unknown[]) => getSharedCodexAppServerClientMock(...args),
  getLeasedSharedCodexAppServerClient: (...args: unknown[]) =>
    getSharedCodexAppServerClientMock(...args),
  retainSharedCodexAppServerClientByInstanceId: async () => ({
    client: await getSharedCodexAppServerClientMock(),
    release: vi.fn(),
  }),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  retireSharedCodexAppServerClientIfCurrent: (...args: unknown[]) =>
    retireSharedCodexAppServerClientIfCurrentMock(...args),
  withCodexAppServerClientRequestScope: (params: RequestScopeParams) =>
    withCodexAppServerClientRequestScopeMock(params),
}));

vi.mock("./approval-bridge.js", () => ({
  handleCodexAppServerApprovalRequest: (...args: unknown[]) =>
    handleCodexAppServerApprovalRequestMock(...args),
}));

vi.mock("./provider-capabilities.js", () => ({
  resolveCodexProviderWebSearchSupportForClient: (...args: unknown[]) =>
    resolveCodexProviderWebSearchSupportForClientMock(...args),
}));

export const { runCodexAppServerSideQuestion: runCodexAppServerSideQuestionImpl } =
  await import("./side-question.js");
const bindingStore: CodexAppServerBindingStore = {
  ...createCodexTestBindingStore(),
  read: (...args) => readCodexAppServerBindingMock(...args),
  readAsync: async (...args) => readCodexAppServerBindingMock(...args),
};

export async function runCodexAppServerSideQuestion(
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

export function createFakeClient(
  options: { completeTurn?: boolean; onTurnStart?: () => void } = {},
) {
  const fixture = createFakeCodexAppServerClient();
  const client = Object.assign(fixture.client, {
    notifications: fixture.notifications,
    request: fixture.request,
    requests: fixture.requests,
    emit: (notification: CodexServerNotification) => {
      void fixture.notify(notification);
    },
    handleRequest: fixture.handleServerRequest,
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
    if (method === "thread/backgroundTerminals/list") {
      return { data: [] };
    }
    return sideRequestResult(method);
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
  const command = ["hooks.PreToolUse", "hooks.PostToolUse", "hooks.PermissionRequest", "hooks.Stop"]
    .flatMap((key) => {
      const entries = record?.[key];
      return Array.isArray(entries)
        ? (entries as Array<{ hooks?: Array<{ command?: string }> }>).map(
            (entry) => entry.hooks?.find((hook) => typeof hook.command === "string")?.command,
          )
        : [];
    })
    .find(Boolean);
  const match = command?.match(/--relay-id ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay id missing from command: ${command}`);
  }
  return match[1];
}

export function threadResult(threadId: string) {
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

export function turnStartResult(turnId: string) {
  return { turn: { ...nativeTurnStartResult(turnId).turn, threadId: "side-thread" } };
}

export function agentDelta(
  threadId: string,
  turnId: string,
  delta: string,
): CodexServerNotification {
  return {
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "agent-1", delta },
  };
}

export function turnCompleted(
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

export const TEST_HOST_CAPABILITIES: SideQuestionParams["hostCapabilities"] = Object.freeze({
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

export function sideParams(overrides: Partial<SideQuestionParams> = {}): SideQuestionParams {
  let hostCapabilities = overrides.hostCapabilities ?? TEST_HOST_CAPABILITIES;
  if (!hostCapabilities.createToolSurfaceAsync) {
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
    setRuntimeConfigSnapshot({});
    retireSharedCodexAppServerClientIfCurrentMock.mockReset();
    handleCodexAppServerApprovalRequestMock.mockReset();
    withCodexAppServerClientRequestScopeMock.mockReset().mockImplementation(runRequestScope);
    resolveCodexProviderWebSearchSupportForClientMock.mockReset().mockResolvedValue("supported");

    toolExecuteMock.mockReset().mockResolvedValue({
      content: [{ type: "text", text: "tool output" }],
    });
    createOpenClawCodingToolsMock
      .mockReset()
      .mockReturnValue([
        fakeTool("wiki_status", "Check wiki status"),
        fakeTool("web_search", "Search the web"),
      ]);

    readCodexAppServerBindingMock.mockReset().mockReturnValue({
      threadId: "parent-thread",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    isCodexAppServerNativeAuthProfileMock.mockReset().mockReturnValue(true);
    getSharedCodexAppServerClientMock.mockReset().mockResolvedValue(createFakeClient());
  });

  afterEach(async () => {
    await nativeHookRelayTesting.clearNativeHookRelaysForTests();
    clearRuntimeConfigSnapshot();
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}

export function fakeTool(name: string, description: string) {
  return {
    name,
    description,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: toolExecuteMock,
  };
}

export async function runSideQuestionWithManagedWebSearchCall(
  params: Parameters<typeof runCodexAppServerSideQuestion>[0] = sideParams(),
  options: {
    preserveToolFactory?: boolean;
    toolName?: string;
    toolArguments?: JsonObject;
  } = {},
) {
  const client = createPendingClient();
  const turnStarted = createDeferred<void>();
  if (!options.preserveToolFactory) {
    createOpenClawCodingToolsMock.mockReturnValue([fakeTool("web_search", "Search the web")]);
  }
  const baseRequest = client.request.getMockImplementation()!;
  client.request.mockImplementation(async (method: string) => {
    if (method === "turn/start") {
      queueMicrotask(() => turnStarted.resolve());
    }
    return baseRequest(method);
  });
  getSharedCodexAppServerClientMock.mockResolvedValue(client);

  const run = runCodexAppServerSideQuestion(params);
  await turnStarted.promise;
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

export function createPendingClient({ interrupt = true } = {}) {
  const client = createFakeClient({ completeTurn: false });
  client.request.mockImplementation(async (method: string) =>
    interrupt && method === "turn/interrupt" ? {} : sideRequestResult(method),
  );
  return client;
}

function sideRequestResult(method: string) {
  switch (method) {
    case "thread/fork":
      return threadResult("side-thread");
    case "turn/start":
      return turnStartResult("turn-1");
    case "thread/inject_items":
    case "thread/unsubscribe":
      return {};
    default:
      throw new Error(`unexpected request: ${method}`);
  }
}
