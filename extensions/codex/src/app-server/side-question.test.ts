import "./side-question.test-support.js";
import assert from "node:assert/strict";
import { Server } from "node:http";
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
  loadWebFetchToolFactoryForTest,
  useProviderToolSchemaRuntimeForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as clientCleanup from "./attempt-client-cleanup.js";
import { codexTestTurnIds, nativeCommandItem } from "./codex-app-server.test-fixtures.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import { CodexEphemeralTurn } from "./ephemeral-turn.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject, type JsonValue } from "./protocol.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  createClientHarness,
  createCodexTestModel,
  waitForHarnessRequest,
} from "./test-support.js";

const {
  codexHookCommand,
  readCodexAppServerBindingMock: readBinding,
  isCodexAppServerNativeAuthProfileMock: isNativeAuthProfile,
  getSharedCodexAppServerClientMock: acquireClient,
  retireSharedCodexAppServerClientIfCurrentMock: retireClient,
  createOpenClawCodingToolsMock: createTools,
  toolExecuteMock: executeTool,
  handleCodexAppServerApprovalRequestMock: approveRequest,
  resolveCodexProviderWebSearchSupportForClientMock: resolveSearchSupport,
  runCodexAppServerSideQuestion: runSideQuestion,
  runSideQuestionWithManagedWebSearchCall,
  runCodexAppServerSideQuestionImpl: runSideQuestionImpl,
  createFakeClient,
  createPendingClient,
  threadResult,
  turnStartResult,
  agentDelta,
  turnCompleted,
  sideParams,
  platformPreparedRuntimeAuth,
  TEST_HOST_CAPABILITIES,
  useSideQuestionTestSetup,
  extractRelayIdFromThreadConfig,
  sideLoopRelayParams,
} = await import("./side-question.test-support.js");

function runSide(
  overrides: Parameters<typeof sideParams>[0] = {},
  options?: Parameters<typeof runSideQuestion>[1],
) {
  return runSideQuestion(sideParams(overrides), options);
}

async function expectSideAnswer(...args: Parameters<typeof runSide>) {
  await expect(runSide(...args)).resolves.toEqual({ text: "Side answer." });
}

function useClient(options?: Parameters<typeof createFakeClient>[0]) {
  const client = createFakeClient(options);
  acquireClient.mockResolvedValue(client);
  return client;
}

function scriptRequests(
  client: ReturnType<typeof createFakeClient>,
  handlers: Record<string, JsonValue | ((params?: unknown) => unknown)>,
) {
  const fallback = client.request.getMockImplementation()!;
  client.request.mockImplementation(async (method: string, params?: unknown) => {
    const handler = handlers[method];
    return handler === undefined
      ? fallback(method, params)
      : typeof handler === "function"
        ? handler(params)
        : handler;
  });
}

function waitForTurn(started: Promise<void>, run: Promise<unknown>) {
  return Promise.race([
    started,
    run.then((cause) => {
      throw new Error("Side question ended before accepting its turn", { cause });
    }),
  ]);
}

function completeSide(client: ReturnType<typeof createFakeClient>, text = "Side answer.") {
  client.emit(agentDelta("side-thread", "turn-1", text));
  client.emit(turnCompleted("side-thread", "turn-1", text));
}

function supervisedParent(model = "gpt-5.5") {
  readBinding.mockReturnValue({
    threadId: "parent-thread",
    cwd: "/tmp/workspace",
    model,
    modelProvider: "openai",
    connectionScope: "supervision",
    supervisionSourceThreadId: "source-thread",
    appServerRuntimeFingerprint: supervisionConnectionFingerprint(),
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
  });
}

function guardedRelayParams(runId: string, overrides: Parameters<typeof sideParams>[0] = {}) {
  return sideLoopRelayParams({
    sessionKey: "agent:main:session-1",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: 1,
      permissionMode: "guarded",
      sessionRoot: "/tmp/workspace",
    },
    messageChannel: "discord",
    messageProvider: "discord-voice",
    opts: { runId },
    ...overrides,
  });
}

function pendingSide() {
  const turnStarted = createDeferred<void>();
  const client = useClient({ completeTurn: false, onTurnStart: turnStarted.resolve });
  return { client, turnStarted };
}

function blockedTool(message?: string) {
  const started = createDeferred<void>();
  let signal: AbortSignal | undefined;
  let aborted = false;
  executeTool.mockImplementation((_callId: string, _args: unknown, current?: AbortSignal) => {
    signal = current;
    started.resolve();
    return new Promise((_resolve, reject) => {
      current?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(
            message
              ? new Error(message)
              : current.reason instanceof Error
                ? current.reason
                : new Error("aborted"),
          );
        },
        { once: true },
      );
    });
  });
  return {
    started: started.promise,
    get signal() {
      return signal;
    },
    get aborted() {
      return aborted;
    },
  };
}

function emitItem(
  client: ReturnType<typeof createFakeClient>,
  phase: "started" | "completed",
  item: JsonValue,
) {
  client.emit({ method: `item/${phase}`, params: { ...codexTestTurnIds("side-thread"), item } });
}

function requestSideTool(
  client: ReturnType<typeof createFakeClient>,
  { id, ...params }: { id: number | string; tool: string; callId: string; arguments: JsonValue },
  signal?: AbortSignal,
) {
  return client.handleRequest(
    { id, method: "item/tool/call", params: { ...codexTestTurnIds("side-thread"), ...params } },
    signal,
  );
}

function requestedParams(client: ReturnType<typeof createFakeClient>, method: string) {
  const value = client.request.mock.calls.find(([name]) => name === method)?.[1];
  return isJsonObject(value) ? value : undefined;
}

function elicitationRequest(id: string) {
  return {
    id,
    method: "mcpServer/elicitation/request",
    params: {
      ...codexTestTurnIds("side-thread"),
      serverName: "forms",
      mode: "form",
      message: "Enter a value",
      requestedSchema: { type: "object", properties: { value: { type: "string" } } },
    },
  };
}

function captureDiagnostics() {
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => events.push(event));
  return { events, stop };
}

function supervisionConnectionFingerprint(): string {
  return buildCodexAppServerConnectionFingerprint(
    resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: { supervision: { enabled: true } },
    }),
  );
}

function mockCall(mock: ReturnType<typeof vi.fn>, index = 0): unknown[] {
  const call = mock.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call;
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

beforeAll(() => setRuntimeConfigSnapshot({}));
afterAll(() => clearRuntimeConfigSnapshot());

useProviderToolSchemaRuntimeForTest(["openai", "codex", "lmstudio"]);

describe("runCodexAppServerSideQuestion", () => {
  const tempDirs = useSessionStoreTempDirs(afterAll, "codex-side-question-");

  useSideQuestionTestSetup();

  it("fences a recovered predecessor when its host rotates before the fork", async () => {
    const root = tempDirs.make();
    const storePath = path.join(root, "admitted", "sessions.json");
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:side-continuity",
      sessionId: "before-compaction",
    };
    const current = { ...previous, sessionId: "after-compaction" };
    const scope = { agentId: previous.agentId, sessionKey: previous.sessionKey, storePath };
    await upsertSessionEntry({ ...scope, entry: { sessionId: previous.sessionId, updatedAt: 1 } });
    const sessionEntry = await patchSessionEntry({
      ...scope,
      update: () => ({ sessionId: current.sessionId }),
    });
    assert(sessionEntry, "Expected the committed successor session");
    const parent = { threadId: "parent-thread", cwd: "/tmp/workspace" };
    const persistedBindings = createCodexTestBindingStore();
    await persistedBindings.mutate(previous, { kind: "set", binding: parent });
    const client = createFakeClient();
    acquireClient.mockImplementationOnce(async () => {
      expect(persistedBindings.read(current)).toEqual(parent);
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });
      return client;
    });

    const operation = runSideQuestionImpl(
      sideParams({
        cfg: { session: { store: path.join(root, "configured", "sessions.json") } },
        storePath,
        agentId: current.agentId,
        sessionKey: current.sessionKey,
        sessionId: current.sessionId,
        sessionEntry,
      }),
      { bindingStore: persistedBindings },
    );
    await expect(operation).rejects.toThrow("Codex session generation is no longer current");
    expect(client.request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
    expect(persistedBindings.read(current)).toEqual(parent);
  });

  it("rejects a waiting side question when its app-server client closes", async () => {
    const { client, turnStarted } = pendingSide();
    const controller = new AbortController();
    let outcome: unknown;
    const run = runSide({ opts: { abortSignal: controller.signal } }).catch((error: unknown) => {
      outcome = error;
    });
    try {
      await waitForTurn(turnStarted.promise, run);
      client.close(new Error("app-server transport disconnected"));
      await run;
      expect(outcome).toEqual(
        expect.objectContaining({ message: expect.stringContaining("closed") }),
      );
      expect(outcome).toBeInstanceOf(AggregateError);
      expect(outcome).toMatchObject({
        message: expect.stringContaining("cleanup could not confirm the side turn stopped"),
        cause: { message: expect.stringContaining("closed") },
      });
    } finally {
      controller.abort("test cleanup");
      await run;
    }
  });

  it("cancels an active side tool when its app-server request is cancelled", async () => {
    const { client, turnStarted } = pendingSide();
    const tool = blockedTool("tool cancelled");
    const run = runSide({});
    await turnStarted.promise;
    const requestController = new AbortController();
    const request = requestSideTool(
      client,
      { callId: "tool-1", tool: "wiki_status", arguments: {}, id: "cancelled-side-tool" },
      requestController.signal,
    );
    try {
      await tool.started;
      expect(tool.signal).toBeDefined();
      requestController.abort(new Error("app-server request deadline"));
      expect(tool.signal?.aborted).toBe(true);
    } finally {
      client.emit(turnCompleted("side-thread", "turn-1", "Finished answer."));
      await run;
      await request;
    }
  });

  it("returns billed usage from the side thread without changing its answer", async () => {
    const { client, turnStarted } = pendingSide();
    const run = runSide({});
    await turnStarted.promise;
    client.emit({
      method: "rawResponse/completed",
      params: {
        threadId: "side-thread",
        turnId: "turn-1",
        responseId: "side-response",
        usage: {
          inputTokens: 8,
          cachedInputTokens: 2,
          outputTokens: 4,
          totalTokens: 12,
          reasoningOutputTokens: 3,
        },
      },
    });
    client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
    await expect(run).resolves.toEqual({
      text: "Side answer.",
      usage: {
        input: 6,
        output: 4,
        cacheRead: 2,
        cacheWrite: 0,
        total: 12,
        reasoningTokens: 3,
        contextUsage: { state: "available", promptTokens: 8, totalTokens: 12 },
      },
    });
  });

  it("forks an ephemeral side thread with the current text and image", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T00:30:00.000Z"));
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    const client = useClient();
    const messageContext = {
      chatType: "channel",
      currentChannelId: "voice-room",
      agentAccountId: "account-1",
      messageTo: "channel-1",
      messageThreadId: "thread-1",
      groupId: "group-1",
      groupChannel: "#ops",
      groupSpace: "workspace-1",
      spawnedBy: "agent:main:parent",
      senderId: "sender-1",
      senderName: "Rosita",
      senderUsername: "rosita",
      senderE164: "+15550001",
      senderIsOwner: true,
      messageActionTurnCapability: "turn-capability-1",
    } as const;
    createTools.mockReturnValue([
      ...createTools.getMockImplementation()!(),
      {
        name: "session_status",
        description: "Show session status",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: executeTool,
      },
    ]);

    const result = await runSide(
      {
        question: " Describe this image. ",
        images: [{ type: "image", data, mimeType: "image/png" }],
        cfg: { agents: { defaults: { userTimezone: "America/Los_Angeles" } } } as never,
        messageChannel: "discord",
        messageProvider: "discord-voice",
        chatId: "discord-native-room",
        ...messageContext,
        sessionKey: "agent:main:conversation",
        sandboxSessionKey: "agent:main:runtime-policy",
      },
      { runtimeModelId: "codex-side-execution-model" },
    );

    expect(result).toEqual({ text: "Side answer." });
    expect(mockCall(acquireClient)[0]).toMatchObject({
      preparedAuth: {
        kind: "profile",
        profileId: "openai:work",
        store: expect.objectContaining({
          profiles: expect.objectContaining({ "openai:work": expect.any(Object) }),
        }),
      },
    });
    expect(mockCall(acquireClient)[0]).not.toHaveProperty("authProfileId");
    const forkCall = mockCall(client.request);
    expect(forkCall?.[0]).toBe("thread/fork");
    const forkParams = forkCall?.[1] as Record<string, unknown> | undefined;
    expect(forkParams).toMatchObject({
      threadId: "parent-thread",
      model: "codex-side-execution-model",
      cwd: "/tmp/workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
      ephemeral: true,
      excludeTurns: true,
      threadSource: "user",
    });
    expect(forkParams).not.toHaveProperty("personality");
    expect(forkParams?.developerInstructions).toContain("You are in a side conversation");
    expect(forkParams?.developerInstructions).toContain(
      "Only the current side question and subsequent requests in this side conversation are active.",
    );
    const injectCall = mockCall(client.request, 1);
    expect(injectCall[0]).toBe("thread/inject_items");
    expect(injectCall[1]).toMatchObject({
      threadId: "side-thread",
      items: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: expect.stringContaining(
                "unless the user explicitly requests that mutation in this side conversation",
              ),
            },
          ],
        },
      ],
    });
    const turnStartCall = client.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall?.[1]).toMatchObject({
      threadId: "side-thread",
      input: [
        { type: "text", text: "Describe this image.", text_elements: [] },
        { type: "image", url: `data:image/png;base64,${data}` },
      ],
      additionalContext: {
        openclaw_temporal_context: {
          kind: "application",
          value:
            "## Temporal Context\nCurrent date: 2026-09-01\nTime zone: America/Los_Angeles\nFor the exact current time, use `session_status`.",
        },
      },
      model: "codex-side-execution-model",
      personality: "none",
      effort: null,
      collaborationMode: {
        mode: "default",
        settings: {
          model: "codex-side-execution-model",
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    });
    const turnStartParams = turnStartCall?.[1] as Record<string, unknown> | undefined;
    expect(turnStartParams).not.toHaveProperty("approvalPolicy");
    expect(turnStartParams).not.toHaveProperty("sandboxPolicy");
    expect(client.request.mock.calls.at(-1)).toEqual([
      "thread/unsubscribe",
      { threadId: "side-thread" },
      { timeoutMs: 60_000 },
    ]);
    expect(client.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);

    const [toolOptions] = mockCall(createTools);
    expect(toolOptions).toMatchObject({
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      sessionId: "session-1",
      modelProvider: "openai",
      modelId: "gpt-5.5",
      messageProvider: "discord",
      toolPolicyMessageProvider: "discord-voice",
      ...messageContext,
      nativeChannelId: "discord-native-room",
      sessionKey: "agent:main:runtime-policy",
      runSessionKey: "agent:main:conversation",
      requireExplicitMessageTarget: true,
    });
  });

  it("clamps stale full access to the guarded agent workspace", async () => {
    const root = "/tmp/workspace";
    readBinding.mockReturnValue({
      threadId: "parent-thread",
      cwd: "/tmp/outside-session-root",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const client = useClient();

    await expectSideAnswer({
      sessionKey: "agent:main:session-1",
      sessionEntry: {
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        updatedAt: 1,
        permissionMode: "guarded",
      },
    });

    expect(mockCall(client.request)[1]).toMatchObject({
      cwd: root,
      runtimeWorkspaceRoots: [root],
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    expect(mockCall(createTools)[0]).toMatchObject({
      exec: { mode: "ask" },
      sessionPermissionPolicy: { mode: "guarded", root },
    });
  });

  it("returns an explicit unsupported decline for ordinary MCP input", async () => {
    const approvalSpy = vi.spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest");
    const { client, turnStarted } = pendingSide();
    const run = runSide({});
    await turnStarted.promise;

    const item = {
      type: "mcpToolCall",
      id: "side-mcp",
      server: "configured-server",
      tool: "raw-tool",
      arguments: { query: "side query" },
      status: "inProgress",
    };
    emitItem(client, "started", item);

    await expect(client.handleRequest(elicitationRequest("side-elicitation"))).resolves.toEqual({
      action: "decline",
      content: null,
      _meta: { message: "OpenClaw Codex side questions do not support interactive MCP input." },
    });

    const correlate = approvalSpy.mock.calls[0]?.[0].getActiveMcpToolCall;
    try {
      expect(correlate?.(item.server)).toEqual({
        id: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
      });
    } finally {
      completeSide(client, "Side answer.");
      await expect(run).resolves.toEqual({ text: "Side answer." });
    }
    expect(correlate?.(item.server)).toBeUndefined();
  });

  it("routes a remote-exec side question through the injected sandbox environment", async () => {
    const client = createPendingClient();
    scriptRequests(client, {
      "environment/add": {},
      "turn/start": async () => {
        queueMicrotask(() => {
          completeSide(client, "Remote answer.");
        });
        return turnStartResult("turn-1");
      },
    });
    acquireClient.mockResolvedValue(client);
    const sandbox = {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec" as const,
      containerWorkdir: "/remote/synced-workspace",
    };

    await expect(runSide({ sandbox })).resolves.toEqual({ text: "Remote answer." });

    const environmentAdd = client.request.mock.calls.find(
      ([method]) => method === "environment/add",
    );
    const environment = environmentAdd?.[1] as
      | { environmentId?: string; execServerUrl?: string }
      | undefined;
    expect(environment?.environmentId).toMatch(/^openclaw-sandbox-/u);
    expect(environment?.execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/u);
    const forkParams = requestedParams(client, "thread/fork");
    expect(forkParams).toMatchObject({ cwd: "/remote/synced-workspace" });
    expect(forkParams).not.toHaveProperty("sandbox");
    const turnParams = requestedParams(client, "turn/start");
    expect(turnParams).toMatchObject({
      cwd: "/remote/synced-workspace",
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      environments: [
        { environmentId: environment?.environmentId, cwd: "/remote/synced-workspace" },
      ],
    });
  });

  it("rejects paired-node side questions before acquiring authority", async () => {
    const client = useClient();
    const openDuplex = vi.fn(async () => {
      throw new Error("node side-question channel was opened");
    });
    const requestApproval = vi.fn(async () => undefined);
    const sandbox = {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec" as const,
      placementNodeId: "paired-device-1",
      placementEnvironmentId: "environment-1",
      placementSessionId: "session-1",
      placementOwnerEpoch: 1,
      sessionKey: "agent:main:session-1",
    };

    await expect(
      runSide(
        { sandbox, hostCapabilities: { ...TEST_HOST_CAPABILITIES, requestApproval } },
        { runtime: { nodes: { openDuplex } } as never },
      ),
    ).rejects.toThrow(
      "Normal Codex turns are supported on nodes, but /btw is not yet bound to the active placement.",
    );

    expect(acquireClient).not.toHaveBeenCalled();
    expect(openDuplex).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
    expect(createTools).not.toHaveBeenCalled();
  });

  it.each([
    { route: "Platform", error: "Prepared Codex API-key route is missing its resolved API key" },
    {
      route: "subscription",
      error: "Prepared Codex subscription route requires a scoped native OAuth or token profile",
    },
  ])("rejects an unprepared $route plan before client acquisition", async ({ route, error }) => {
    const platform = route === "Platform";
    if (!platform) {
      isNativeAuthProfile.mockReturnValue(false);
    }
    await expect(
      runSide({
        authProfileId: undefined,
        authProfileIdSource: undefined,
        ...(platform
          ? {
              provider: "openai",
              model: "gpt-5.6",
              runtimeModel: {
                ...createCodexTestModel(),
                id: "gpt-5.6",
                api: "openai-responses" as const,
                baseUrl: "https://api.openai.com/v1",
              },
              preparedRuntimeAuth: platformPreparedRuntimeAuth(),
            }
          : {}),
      }),
    ).rejects.toThrow(error);

    expect(acquireClient).not.toHaveBeenCalled();
    if (platform) {
      expect(isNativeAuthProfile).not.toHaveBeenCalled();
    } else {
      expect(isNativeAuthProfile).toHaveBeenCalledWith(
        expect.objectContaining({ authProfileId: undefined, authProfileStore: expect.any(Object) }),
      );
    }
  });

  it("uses the default supervision runtime, native auth, and exact bound model pair", async () => {
    const client = useClient();
    supervisedParent();

    await expectSideAnswer(
      {
        provider: "anthropic",
        model: "claude-opus-4-6",
        runtimeModel: {
          id: "claude-opus-4-6",
          provider: "anthropic",
          compat: { supportsTools: false, supportedReasoningEfforts: ["none", "high"] },
        } as never,
        resolvedThinkLevel: "off",
        authProfileId: "openai:outer",
      },
      { pluginConfig: { supervision: { enabled: true } } },
    );

    expect(acquireClient).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
    const forkCall = client.request.mock.calls.find(([method]) => method === "thread/fork");
    expect(forkCall?.[1]).toMatchObject({
      threadId: "parent-thread",
      model: "gpt-5.5",
      modelProvider: "openai",
    });
    const turnCall = client.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnCall?.[1]).toMatchObject({ model: "gpt-5.5" });
    expect(turnCall?.[1]).not.toHaveProperty("effort");
    expect(turnCall?.[1]).not.toHaveProperty("collaborationMode");
    expect(turnCall?.[1]).not.toHaveProperty("personality");
    expect(createTools).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "openai", modelId: "gpt-5.5" }),
    );
  });

  it("cleans up a supervised fork that returns a different native model pair", async () => {
    const client = useClient();
    supervisedParent("gpt-5.4");

    await expect(runSide({}, { pluginConfig: { supervision: { enabled: true } } })).rejects.toThrow(
      "did not preserve its native model and provider",
    );

    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
    ]);
  });

  it("projects bound ask policy before side-thread forks", async () => {
    const approvalSpy = vi.spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest");
    const nativeAppConfig = {
      enabled: true,
      links: {
        account: { approvals_reviewer: "auto_review", default_tools_approval_mode: "approve" },
      },
      tools: {
        write: { enabled: false, approval_mode: "approve" },
        read: { approval_mode: "approve" },
        retired: { approval_mode: "approve" },
      },
    };
    const savedAppConfig = structuredClone(nativeAppConfig);
    const { client, turnStarted } = pendingSide();
    scriptRequests(client, {
      "app/installed": {
        apps: ["ask-app", "unbound-app"].map((id) => ({
          id,
          runtimeName: id,
          enabled: true,
          callable: true,
        })),
      },
      "app/read": async (requestParams) => {
        expect(requestParams).toEqual({ appIds: ["ask-app"], includeTools: true });
        return {
          apps: [
            {
              id: "ask-app",
              name: "Ask",
              pluginDisplayNames: [],
              toolSummaries: [false, true].map((readOnly) => ({
                name: readOnly ? "read" : "write",
                title: null,
                description: null,
                isEnabled: readOnly,
                disabledReason: null,
                isReadOnly: readOnly,
              })),
            },
          ],
          missingAppIds: [],
        };
      },
      "config/read": { config: { apps: { "ask-app": nativeAppConfig } }, layers: [] },
      "config/batchWrite": async () => {
        throw new Error("side-question admission cannot write saved app settings");
      },
      "config/value/write": async () => {
        throw new Error("side-question admission cannot write saved app settings");
      },
    });
    readBinding.mockReturnValue({
      schemaVersion: 2,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      pluginAppPolicyContext: {
        fingerprint: "mixed-plugin-policy",
        apps: Object.fromEntries(
          [
            ["ask", "ask"],
            ["true", "allow"],
            ["false", "deny"],
            ["auto", "auto"],
          ].map(([name, mode]) => [
            `${name}-app`,
            {
              configKey: name,
              marketplaceName: "openai",
              pluginName: name,
              allowDestructiveActions: mode !== "deny",
              destructiveApprovalMode: mode,
              mcpServerNames: [name],
            },
          ]),
        ),
        pluginAppIds: {
          ask: ["ask-app"],
          true: ["true-app"],
          false: ["false-app"],
          auto: ["auto-app"],
        },
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    const run = runSide({}, { pluginConfig: { appServer: { mode: "guardian" } } });
    await waitForTurn(turnStarted.promise, run);
    try {
      const response = await client.handleRequest(elicitationRequest("side-approval-policy"));
      expect(response).not.toBeUndefined();
      const policy = approvalSpy.mock.calls.at(-1)?.[0].pluginAppPolicyContext;
      expect(Object.keys(policy?.apps ?? {}).toSorted()).toEqual([
        "ask-app",
        "auto-app",
        "false-app",
        "true-app",
      ]);
      expect(policy?.pluginAppIds.ask).toEqual(["ask-app"]);
    } finally {
      completeSide(client, "Side answer.");
      await expect(run).resolves.toEqual({ text: "Side answer." });
    }

    const methods = client.request.mock.calls.map(([method]) => method);
    expect(methods.indexOf("app/read")).toBeLessThan(methods.indexOf("thread/fork"));
    expect(methods.filter((method) => method === "config/read")).toHaveLength(1);
    expect(methods).not.toContain("config/batchWrite");
    expect(methods).not.toContain("config/value/write");
    expect(nativeAppConfig).toEqual(savedAppConfig);
    const forkParams = requestedParams(client, "thread/fork") as
      | Record<string, unknown>
      | undefined;
    expect(forkParams?.approvalsReviewer).toBe("auto_review");
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(config).not.toHaveProperty("approvals_reviewer");
    expect(config?.["features.code_mode"]).toBe(true);
    expect(config?.apps).toEqual({
      _default: { enabled: false, destructive_enabled: false, open_world_enabled: false },
      "ask-app": {
        enabled: true,
        approvals_reviewer: "user",
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
        links: { account: { approvals_reviewer: "user", default_tools_approval_mode: "auto" } },
        tools: { write: { approval_mode: "auto" } },
      },
      "auto-app": { enabled: true, destructive_enabled: true, open_world_enabled: true },
      "false-app": { enabled: true, destructive_enabled: false, open_world_enabled: true },
      "true-app": { enabled: true, destructive_enabled: true, open_world_enabled: true },
    });
  });

  it.each(["sender denial", "managed provider"] as const)(
    "disables side-question search for %s",
    async (reason) => {
      const senderDenied = reason === "sender denial";
      // Missing managed credentials are not a denial; hosted search uses the policy owner.
      if (senderDenied) {
        createTools.mockReturnValue([]);
      }

      const { forkConfig, result, toolResponse } = await runSideQuestionWithManagedWebSearchCall(
        sideParams({
          ...(senderDenied ? { senderId: "restricted-sender" } : {}),
          cfg: senderDenied
            ? { tools: { toolsBySender: { "id:restricted-sender": { deny: ["web_search"] } } } }
            : { tools: { web: { search: { provider: "brave" } } } },
        }),
        senderDenied ? { preserveToolFactory: true } : undefined,
      );

      if (senderDenied) {
        expect(createTools).toHaveBeenCalledWith(
          expect.objectContaining({ senderId: "restricted-sender" }),
        );
      } else {
        expect(result).toEqual({ text: "Search answer." });
        expect(resolveSearchSupport).not.toHaveBeenCalled();
      }
      expect(forkConfig).toMatchObject({
        "features.standalone_web_search": false,
        web_search: "disabled",
      });
      expect(toolResponse).toEqual({
        success: false,
        contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: web_search" }],
      });
      expect(executeTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "rejects side questions before forking when the tool allowlist excludes native tools",
      params: {
        messageChannel: "telegram",
        messageProvider: "telegram",
        senderId: "restricted-sender",
        toolsAllow: ["message"],
      },
      error:
        "Codex-native /btw side-question mode is unavailable because the effective tool policy restricts Codex native tools for this session.",
      checkSearch: true,
    },
    {
      name: "checks /btw native execution against the runtime-policy session",
      params: {
        cfg: {
          agents: {
            defaults: { sandbox: { mode: "non-main", scope: "agent" } },
            entries: { main: {} },
          },
        } as never,
        sessionKey: "agent:main:main",
        sandboxSessionKey: "agent:main:whatsapp:personal:direct:15555550123",
      },
      error:
        "Codex-native /btw side-question mode is unavailable because OpenClaw sandboxing is active for this session.",
      checkSearch: false,
    },
    {
      name: "uses the retained agent for an unscoped explicit-roster side question",
      params: {
        agentId: "alpha",
        cfg: {
          tools: { exec: { host: "gateway" } },
          agents: {
            entries: { alpha: { tools: { exec: { host: "node", node: "worker-1" } } }, beta: {} },
          },
        } as never,
        sessionKey: "node-session",
      },
      error:
        "Codex-native /btw side-question mode is unavailable because OpenClaw exec host=node is active for this session.",
      checkSearch: false,
    },
  ])("$name", async ({ params, error, checkSearch }) => {
    await expect(runSide(params)).rejects.toThrow(error);
    expect(acquireClient).not.toHaveBeenCalled();
    if (checkSearch) {
      expect(resolveSearchSupport).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      name: "blocks an outside host",
      allowedDomains: ["1.1.1.1"],
      url: "http://8.8.8.8/",
      success: false,
    },
    {
      name: "allows a permitted host",
      allowedDomains: ["1.1.1.1"],
      url: "http://1.1.1.1/",
      success: true,
    },
  ])("applies native search domains to side-question web_fetch and $name", async (testCase) => {
    const createWebFetchTool = await loadWebFetchToolFactoryForTest();
    createTools.mockImplementation((options) => {
      const toolOptions = options as NonNullable<
        Parameters<
          (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"]
        >[0]
      >;
      const webFetchTool = createWebFetchTool({
        config: toolOptions.config,
        sandboxed: toolOptions.sandbox?.enabled === true,
        lateBindRuntimeConfig: true,
        hostnameAllowlistRef: toolOptions.webFetchHostnameAllowlistRef,
      });
      return webFetchTool ? [webFetchTool] : [];
    });
    const fetchMock = vi.fn(
      async () =>
        new Response("permitted", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { toolResponse } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({
        preparedWebSearchPolicy: { allowed: true, persistentAllowed: true },
        cfg: {
          tools: {
            web: {
              search: { openaiCodex: { allowedDomains: testCase.allowedDomains } },
              fetch: { cacheTtlMinutes: 0 },
            },
          },
        } as never,
      }),
      { preserveToolFactory: true, toolName: "web_fetch", toolArguments: { url: testCase.url } },
    );

    expect(toolResponse).toMatchObject({ success: testCase.success });
    expect(fetchMock).toHaveBeenCalledTimes(testCase.success ? 1 : 0);
    if (!testCase.success) {
      expect(toolResponse).toEqual({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: expect.stringMatching(/Domain policy: Blocked hostname.*1\.1\.1\.1/),
          },
        ],
      });
    }
  });

  it("revokes native hook authority on close while projecting caller cancellation", async () => {
    const { client, turnStarted } = pendingSide();
    const projecting = createDeferred<void>();
    const finishProjection = createDeferred<void>();
    const controller = new AbortController();
    const run = runSideQuestion(
      sideLoopRelayParams({
        opts: {
          abortSignal: controller.signal,
          onAssistantMessageStart: async () => {
            projecting.resolve();
            await finishProjection.promise;
          },
        },
      }),
      { nativeHookRelay: { enabled: true } },
    );
    let runError: unknown;
    const settled = run.catch((error: unknown) => {
      runError = error;
    });
    try {
      await waitForTurn(turnStarted.promise, settled);
      const fork = requestedParams(client, "thread/fork");
      const relayId = extractRelayIdFromThreadConfig(
        (fork as { config?: Record<string, unknown> }).config,
      );
      client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
      await projecting.promise;
      client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
      client.close();

      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: {
            tool_name: "Bash",
            tool_input: { command: "echo synthetic" },
            tool_use_id: "late-native-tool",
          },
        }),
      ).rejects.toThrow("native hook relay not found");
      client.request.mockRejectedValue(new Error("app-server client is closed"));
      controller.abort("caller stopped while draining");
      await vi.waitFor(
        () =>
          expect(runError).toEqual(
            expect.objectContaining({
              message: expect.stringMatching(
                /^Codex \/btw was aborted\..*background-terminal cleanup failed/,
              ),
              cause: expect.objectContaining({ message: "Codex /btw was aborted." }),
            }),
          ),
        { timeout: 200 },
      );
      expect(runError).toBeInstanceOf(AggregateError);
      expect(client.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
      expect(client.request).toHaveBeenCalledWith(
        "thread/backgroundTerminals/list",
        { threadId: "side-thread" },
        expect.any(Object),
      );
    } finally {
      controller.abort("fixture cleanup");
      finishProjection.resolve();
      await settled;
    }
  });

  it("keeps side hooks after listener failure", async () => {
    vi.spyOn(Server.prototype, "listen").mockImplementationOnce(function (this: Server) {
      queueMicrotask(() => this.emit("error", new Error("fixture side listener unavailable")));
      return this;
    });
    const beforeToolCall = vi.fn(() => ({
      block: true,
      blockReason: "fixture side policy denial",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const host = await createAdmittedHostCapabilityTestFixture({ runId: "run-side-1" });
    const client = createPendingClient();
    let relayIdDuringFork: string | undefined;
    scriptRequests(client, {
      "thread/fork": async (requestParams) => {
        const config = (requestParams as { config?: Record<string, unknown> }).config;
        relayIdDuringFork = extractRelayIdFromThreadConfig(config);
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork),
        ).toMatchObject({
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-side-1",
          channelId: "voice-room",
          allowedEvents: ["pre_tool_use", "post_tool_use", "before_agent_finalize"],
        });
        const generation = codexHookCommand(config, "hooks.PreToolUse")?.command?.match(
          /--generation ([^ ]+)/,
        )?.[1];
        const response = await invokeNativeHookRelay({
          provider: "codex",
          relayId: relayIdDuringFork,
          generation,
          requireGeneration: true,
          event: "pre_tool_use",
          rawPayload: {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_use_id: "side-listener-unavailable-tool",
            tool_input: { command: "pwd" },
          },
        });
        expect(response.stdout).toContain("fixture side policy denial");
        return threadResult("side-thread");
      },
      "turn/start": async () => {
        queueMicrotask(() => {
          completeSide(client, "Side answer.");
        });
        return turnStartResult("turn-1");
      },
    });
    acquireClient.mockResolvedValue(client);

    await expect(
      runSideQuestion(
        guardedRelayParams("run-side-1", {
          hostCapabilities: host.hostCapabilities,
          currentChannelId: "discord:voice-room",
        }),
        { nativeHookRelay: { enabled: true, hookTimeoutSec: 9 } },
      ).finally(() => {
        host.closeHost();
        host.closeAdmission();
      }),
    ).resolves.toEqual({ text: "Side answer." });

    expect(relayIdDuringFork).toBeDefined();
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(createTools).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-side-1" }));
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork!),
    ).toBeUndefined();
  });

  it("forwards side-thread command approvals through the active native hook relay", async () => {
    const turnStarted = createDeferred<void>();
    const client = createPendingClient();
    let relayIdDuringFork: string | undefined;
    approveRequest.mockResolvedValueOnce({ decision: "decline" });
    scriptRequests(client, {
      "thread/fork": async (requestParams) => {
        const config = (requestParams as { config?: Record<string, unknown> }).config;
        relayIdDuringFork = extractRelayIdFromThreadConfig(config);
        return threadResult("side-thread");
      },
      "turn/start": async () => {
        turnStarted.resolve();
        return turnStartResult("turn-1");
      },
    });
    acquireClient.mockResolvedValue(client);

    const run = runSideQuestion(guardedRelayParams("run-side-approval"), {
      nativeHookRelay: { enabled: true },
    });
    try {
      await waitForTurn(turnStarted.promise, run);
      const approvalResponse = await client.handleRequest({
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: {
          ...codexTestTurnIds("side-thread"),
          itemId: "cmd-side",
          command: "/bin/bash -lc 'node -v'",
          cwd: "/tmp/workspace",
        },
      });
      client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
      await expect(run).resolves.toEqual({ text: "Side answer." });

      expect(approvalResponse).toEqual({ decision: "decline" });
      expect(approveRequest).toHaveBeenCalledOnce();
      expect(approveRequest.mock.calls[0]?.[0]).toMatchObject({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds("side-thread"),
          itemId: "cmd-side",
          command: "/bin/bash -lc 'node -v'",
          cwd: "/tmp/workspace",
        },
        ...codexTestTurnIds("side-thread"),
        autoApprove: false,
        paramsForRun: { messageChannel: "discord", messageProvider: "discord-voice" },
        nativeHookRelay: {
          relayId: relayIdDuringFork,
          allowedEvents: expect.arrayContaining(["pre_tool_use"]),
        },
      });
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork!),
      ).toBeUndefined();
    } finally {
      client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
      await run.catch(() => {});
    }
  });

  it("sends clearing native hook config when side-thread relay is disabled", async () => {
    const client = useClient();

    await expectSideAnswer({}, { nativeHookRelay: { enabled: false } });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(config).toMatchObject({
      "features.hooks": false,
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.shell_tool": true,
      "features.apply_patch_streaming_events": true,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [],
      "hooks.Stop": [],
    });
    expect(config).not.toHaveProperty("hooks.state");
  });

  it("applies network-proxy config to side-thread forks", async () => {
    const client = useClient();

    await expectSideAnswer(
      {},
      {
        pluginConfig: {
          appServer: {
            networkProxy: {
              enabled: true,
              profileName: "side-proxy",
              domains: { "api.openai.com": "allow" },
              unixSockets: { "/tmp/proxy.sock": "allow" },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
      },
    );

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(forkParams).not.toHaveProperty("sandbox");
    expect(config).toMatchObject({
      "features.network_proxy.enabled": true,
      default_permissions: "side-proxy",
      permissions: {
        "side-proxy": {
          filesystem: { ":minimal": "read", ":project_roots": { ".": "write" } },
          network: {
            enabled: true,
            domains: { "api.openai.com": "allow" },
            unix_sockets: { "/tmp/proxy.sock": "allow" },
            allow_upstream_proxy: true,
            proxy_url: "http://127.0.0.1:3128",
          },
        },
      },
    });
    expect(config?.["features.code_mode"]).toBe(true);
    expect(config?.["features.code_mode_only"]).toBe(false);
  });

  it.each([
    {
      name: "qualified local provider",
      provider: "codex",
      model: "lmstudio/local-model",
      boundModel: "gpt-5.5",
      boundProvider: undefined,
      expectedModel: "local-model",
      local: true,
    },
    {
      name: "bound slash-containing id",
      provider: "codex",
      model: "openai/gpt-oss-20b",
      boundModel: "openai/gpt-oss-20b",
      boundProvider: "lmstudio",
      expectedModel: "openai/gpt-oss-20b",
      local: true,
    },
    {
      name: "qualified OpenAI provider",
      provider: "codex",
      model: "openai/gpt-5.5",
      boundModel: "local-model",
      boundProvider: "lmstudio",
      expectedModel: "gpt-5.5",
      local: false,
    },
  ])("preserves side-fork model ownership for $name", async (scenario) => {
    const client = useClient();
    readBinding.mockReturnValue({
      ...readBinding(),
      model: scenario.boundModel,
      modelProvider: scenario.boundProvider,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await expectSideAnswer(
      { provider: scenario.provider, model: scenario.model },
      { pluginConfig: { appServer: { mode: "guardian", codeModeOnly: true } } },
    );
    const fork = mockCall(client.request)[1];
    expect(fork).toMatchObject({
      model: scenario.expectedModel,
      approvalsReviewer: scenario.local ? "user" : "auto_review",
      config: { "features.code_mode": true, "features.code_mode_only": true },
    });
    if (scenario.local) {
      expect(fork).toMatchObject({
        modelProvider: "lmstudio",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
    } else {
      expect(fork).not.toHaveProperty("modelProvider");
    }
  });

  it.each(["startup", "cleanup"] as const)(
    "reports a native pre-tool failure during %s",
    async (phase) => {
      const client = createPendingClient();
      const { events, stop } = captureDiagnostics();
      const toolCallId =
        phase === "startup" ? "side-turn-start-failure-tool" : "side-cleanup-failure-tool";
      let relayId: string;
      let report: NativeHookRelayRegistrationHandle["onPreToolUseFailure"];
      const captureReporter = () => {
        report =
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
            relayId,
          )?.onPreToolUseFailure;
      };
      const reportFailure = () =>
        report?.({ toolName: "exec", toolCallId, disposition: "failed", durationMs: 5 });
      scriptRequests(client, {
        "thread/fork": (params) => {
          relayId = extractRelayIdFromThreadConfig(
            (params as { config?: Record<string, unknown> }).config,
          );
          if (phase === "cleanup") {
            captureReporter();
          }
          return threadResult("side-thread");
        },
        "turn/start": () => {
          if (phase === "startup") {
            captureReporter();
            throw new Error("side turn start exploded");
          }
          queueMicrotask(() => {
            emitItem(client, "started", nativeCommandItem(toolCallId, "inProgress", null));
            client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
          });
          return turnStartResult("turn-1");
        },
        ...(phase === "cleanup"
          ? {
              "thread/unsubscribe": async () => {
                await reportFailure();
                return {};
              },
              "turn/interrupt": {},
            }
          : {}),
      });
      acquireClient.mockResolvedValue(client);
      try {
        const run = runSideQuestion(sideLoopRelayParams(), { nativeHookRelay: { enabled: true } });
        if (phase === "startup") {
          await expect(run).rejects.toThrow("side turn start exploded");
          await reportFailure();
        } else {
          await expect(run).resolves.toEqual({ text: "Side answer." });
        }
        await flushDiagnosticEvents();
      } finally {
        stop();
      }
      const failure = expect.objectContaining({
        type: "tool.execution.error",
        toolCallId,
        terminalReason: "failed",
      });
      if (phase === "startup") {
        expect(events).toContainEqual(failure);
      } else {
        expect(events.filter((event) => event.type.startsWith("tool.execution."))).toEqual([
          expect.objectContaining({ type: "tool.execution.started", toolCallId }),
          expect.objectContaining({
            type: "tool.execution.error",
            toolCallId,
            terminalReason: "failed",
            errorCategory: "before_tool_call",
          }),
        ]);
      }
    },
  );

  it("omits computer control from side threads without a compaction owner", async () => {
    const { client, turnStarted } = pendingSide();
    const computerExecute = vi.fn();
    createTools.mockReturnValue([
      {
        name: "computer",
        description: "Control a desktop",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute: computerExecute,
      },
    ]);
    const run = runSide({});
    await turnStarted.promise;
    const toolResponse = await requestSideTool(client, {
      callId: "computer-1",
      tool: "computer",
      arguments: { action: "screenshot" },
      id: 43,
    });
    completeSide(client, "Side answer.");
    await expect(run).resolves.toEqual({ text: "Side answer." });
    expect(computerExecute).not.toHaveBeenCalled();
    expect(toolResponse).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: computer" }],
    });
  });

  it("aborts active side tools before waiting for thread cleanup", async () => {
    const client = createPendingClient({ interrupt: false });
    const turnStarted = createDeferred<void>();
    const unsubscribeStarted = createDeferred<void>();
    const unsubscribePending = createDeferred<void>();

    const tool = blockedTool("side tool aborted");
    scriptRequests(client, {
      "turn/start": async () => {
        turnStarted.resolve();
        return turnStartResult("turn-1");
      },
      "thread/unsubscribe": async () => {
        unsubscribeStarted.resolve();
        await unsubscribePending.promise;
        return {};
      },
    });
    acquireClient.mockResolvedValue(client);

    const run = runSide({});
    await turnStarted.promise;
    const toolResponse = requestSideTool(client, {
      callId: "tool-1",
      tool: "wiki_status",
      arguments: {},
      id: 42,
    });
    void toolResponse.catch(() => undefined);
    await tool.started;
    client.emit(turnCompleted("side-thread", "turn-1", "Finished answer."));
    try {
      await unsubscribeStarted.promise;
      expect(tool.aborted).toBe(true);
    } finally {
      unsubscribePending.resolve();
    }
    await expect(run).resolves.toEqual({ text: "Finished answer." });
    await toolResponse;
  });

  it("projects native side-thread tool notifications into trusted diagnostics", async () => {
    const client = createPendingClient();
    const { events: diagnosticEvents, stop: unsubscribeDiagnostics } = captureDiagnostics();
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emitItem(client, "started", nativeCommandItem("native-tool-1", "inProgress", null));
          emitItem(client, "completed", nativeCommandItem("native-tool-1", "completed", 12));
          const webSearchItem = {
            type: "webSearch",
            id: "native-search-1",
            query: "sensitive side-thread query",
            action: { type: "search", query: "sensitive side-thread query", queries: null },
          };
          emitItem(client, "started", webSearchItem);
          emitItem(client, "completed", webSearchItem);
          client.emit(turnCompleted("side-thread", "turn-1", "Native tool answer."));
        }, 0);
        return turnStartResult("turn-1");
      }
      return baseRequest(method, requestParams);
    });
    acquireClient.mockResolvedValue(client);

    try {
      await runSide({
        agentId: "side-agent",
        sessionKey: "agent:side-agent:main",
        opts: { runId: "run-side-native-tool" },
      });
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    const toolEvents = diagnosticEvents.filter((event) => event.type.startsWith("tool.execution."));
    expect(
      toolEvents.map((event) => [
        event.type,
        "agentId" in event ? event.agentId : undefined,
        "toolName" in event ? event.toolName : undefined,
        "toolCallId" in event ? event.toolCallId : undefined,
        "durationMs" in event ? event.durationMs : undefined,
      ]),
    ).toEqual([
      ["tool.execution.started", "side-agent", "bash", "native-tool-1", undefined],
      ["tool.execution.completed", "side-agent", "bash", "native-tool-1", 12],
      ["tool.execution.started", "side-agent", "web_search", "native-search-1", undefined],
      ["tool.execution.error", "side-agent", "web_search", "native-search-1", expect.any(Number)],
    ]);
    expect(toolEvents.at(-1)).toMatchObject({
      errorCode: "tool_outcome_unknown",
      terminalReason: "failed",
    });
    expect(JSON.stringify(toolEvents)).not.toContain("sensitive side-thread query");
  });

  it.each(["wiki_status", "autoreview"])(
    "classifies active %s as timed out when side completion expires",
    async (toolName) => {
      if (toolName === "autoreview") {
        createTools.mockReturnValue([
          {
            name: toolName,
            description: "Review",
            parameters: { type: "object", properties: {} },
            execute: executeTool,
          },
        ]);
      }
      const client = createPendingClient();
      const turnStarted = createDeferred<void>();

      const { events: diagnosticEvents, stop: unsubscribeDiagnostics } = captureDiagnostics();
      const tool = blockedTool();
      scriptRequests(client, {
        "turn/start": async () => {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          turnStarted.resolve();
          setTimeout(() => {
            void requestSideTool(client, {
              callId: "tool-timeout",
              tool: toolName,
              arguments: {},
              id: 42,
            });
          }, 0);
          return turnStartResult("turn-1");
        },
        "turn/interrupt": async () => {
          queueMicrotask(() =>
            client.emit(turnCompleted("side-thread", "turn-1", "", "interrupted")),
          );
          return {};
        },
        "thread/backgroundTerminals/list": { data: [] },
      });
      acquireClient.mockResolvedValue(client);

      try {
        const runPromise = runSide({
          agentId: "side-agent",
          sessionKey: "global",
          opts: { runId: "run-side-timeout" },
        });
        const runResult = runPromise.catch((error: unknown) => error);
        await turnStarted.promise;
        await vi.advanceTimersByTimeAsync(0);
        await tool.started;
        await vi.advanceTimersByTimeAsync(590_000);
        if (toolName === "autoreview") {
          expect(diagnosticEvents.filter((event) => event.type === "tool.execution.error")).toEqual(
            [],
          );
        }
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(runResult).resolves.toMatchObject({ name: "TimeoutError" });
        await vi.advanceTimersByTimeAsync(0);
        expect(diagnosticEvents).toContainEqual(
          expect.objectContaining({
            type: "tool.execution.error",
            agentId: "side-agent",
            toolCallId: "tool-timeout",
            terminalReason: "timed_out",
          }),
        );
      } finally {
        unsubscribeDiagnostics();
      }
    },
  );

  it("returns an empty response for side-thread user input requests", async () => {
    const { client, turnStarted } = pendingSide();

    const run = runSide({});
    await turnStarted.promise;
    const userInputResponse = await client.handleRequest({
      id: 43,
      method: "item/tool/requestUserInput",
      params: {
        ...codexTestTurnIds("side-thread"),
        itemId: "input-1",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Pick one",
            options: [{ label: "A", description: "" }],
          },
        ],
      },
    });
    const unrelatedUserInputResponse = await client.handleRequest({
      id: 42,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        itemId: "input-parent",
        questions: [],
      },
    });
    client.emit(turnCompleted("side-thread", "turn-1", "No input needed."));
    const result = await run;

    expect(result).toEqual({ text: "No input needed." });
    expect(unrelatedUserInputResponse).toBeUndefined();
    expect(userInputResponse).toEqual({ answers: {} });
  });

  it("retires an uncertain policy after a lost acknowledgement without replaying the fork", async () => {
    type WrittenRequest = { id: number; method: string; params: unknown };
    const forkWritten = createDeferred<WrittenRequest>();
    const policyWritten = createDeferred<void>();
    const unsubscribeWritten = createDeferred<WrittenRequest>();
    const harness = createClientHarness({
      onWrite(line) {
        const request = JSON.parse(line) as WrittenRequest;
        if (request.method === "thread/fork") {
          forkWritten.resolve(request);
        } else if (request.method === "thread/inject_items") {
          policyWritten.resolve();
        } else if (request.method === "thread/unsubscribe") {
          unsubscribeWritten.resolve(request);
        }
      },
    });
    acquireClient.mockResolvedValue(harness.client);
    const controller = new AbortController();
    const run = runSide({ opts: { abortSignal: controller.signal } });
    const failure = run.catch((error: unknown) => error);
    const fork = await forkWritten.promise;
    harness.send({ id: fork.id, result: threadResult("side-thread") });
    await policyWritten.promise;
    controller.abort("lost policy ACK");
    const unsubscribe = await unsubscribeWritten.promise;
    expect(unsubscribe.params).toEqual({ threadId: "side-thread" });
    harness.send({ id: unsubscribe.id, result: { status: "unsubscribed" } });
    await expect(failure).resolves.toMatchObject({
      name: "CodexThreadPolicyHandoffError",
      outcome: "unknown",
    });
    expect(harness.writes.map((write) => JSON.parse(write).method)).toEqual([
      "thread/fork",
      "thread/inject_items",
      "thread/unsubscribe",
    ]);
    expect(harness.stdinDestroyed).toBe(true);
    harness.client.close();
  });

  it.each(["missing", "stale"] as const)(
    "returns a clear setup error for a %s Codex parent thread",
    async (parent) => {
      if (parent === "missing") {
        readBinding.mockReturnValue(undefined);
      } else {
        const client = createFakeClient({ completeTurn: false });
        client.request.mockImplementation(async (method: string) => {
          if (method === "thread/fork") {
            throw new Error("thread/fork failed: no rollout found for thread id parent-thread");
          }
          return {};
        });
        acquireClient.mockResolvedValue(client);
      }

      await expect(runSide({})).rejects.toThrow(
        "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
      );
      if (parent === "missing") {
        expect(acquireClient).not.toHaveBeenCalled();
      }
    },
  );
  it("executes inherited Gateway shell tools through the side run's host authority", async () => {
    const workspaceDir = tempDirs.make();
    const config = { tools: { exec: { host: "gateway" as const, mode: "full" as const } } };
    const runId = "side-gateway-shell";
    const sessionId = "side-gateway-session";
    const sessionKey = "agent:main:side-gateway-shell";
    const host = await createAdmittedHostCapabilityTestFixture({
      config,
      agentId: "main",
      sessionId,
      sessionKey,
      runId,
      workspaceDir,
      cwd: workspaceDir,
    });
    const { client, turnStarted } = pendingSide();
    const parent = { threadId: "parent-thread", cwd: workspaceDir, model: "gpt-5.5" };
    const run = runSideQuestionImpl(
      sideParams({
        cfg: config,
        runtimeModel: createCodexTestModel("openai"),
        agentDir: workspaceDir,
        workspaceDir,
        sessionId,
        sessionKey,
        sessionEntry: {
          sessionId,
          updatedAt: 1,
          permissionMode: "full",
          sessionRoot: workspaceDir,
        },
        sandbox: null,
        hostCapabilities: host.hostCapabilities,
        opts: { runId },
      }),
      {
        bindingStore: {
          ...createCodexTestBindingStore(),
          read: () => parent,
          readAsync: async () => parent,
        },
      },
    );
    try {
      await waitForTurn(turnStarted.promise, run);
      const execResponse = await requestSideTool(client, {
        callId: "side-gateway-exec",
        tool: "gateway_exec",
        arguments: { command: "printf codex-side-shell", workdir: workspaceDir },
        id: "side-gateway-exec",
      });
      expect(execResponse).toMatchObject({ success: true });
      expect(JSON.stringify(execResponse)).toContain("codex-side-shell");
      const processResponse = await requestSideTool(client, {
        callId: "side-gateway-process",
        tool: "gateway_process",
        arguments: { action: "list" },
        id: "side-gateway-process",
      });
      expect(processResponse).toMatchObject({ success: true });
      client.emit(turnCompleted("side-thread", "turn-1", "Gateway shell inspected."));
      await expect(run).resolves.toEqual({ text: "Gateway shell inspected." });
    } finally {
      client.emit(turnCompleted("side-thread", "turn-1", "Gateway shell inspected."));
      await run.catch(() => {});
      host.closeHost();
      host.closeAdmission();
    }
  });

  it.each(["unwritten", "unsubscribe failure", "retained peer", "retirement failure"] as const)(
    "scopes side-turn abort cleanup for %s",
    async (scenario) => {
      const written = scenario !== "unwritten";
      const retirementFails = scenario === "retirement failure";
      const peerRetained = scenario === "retained peer";
      const interruptFails = retirementFails || peerRetained;
      const unsubscribeFails = scenario === "unsubscribe failure";
      const controller = new AbortController();
      const harness = createClientHarness();
      const requests = vi.spyOn(harness.client, "request");
      if (peerRetained) {
        retireClient.mockReturnValueOnce({
          activeLeases: 2,
          closed: false,
        });
      }
      if (retirementFails) {
        vi.spyOn(harness.client, "closeAndWait").mockRejectedValueOnce(
          new Error("side client retirement failed"),
        );
      }
      acquireClient.mockResolvedValue(harness.client);
      const waitForRequest = (method: string) => waitForHarnessRequest(harness, method);
      const run = runSide({ opts: { abortSignal: controller.signal } });
      const failure = run.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        const fork = await waitForRequest("thread/fork");
        harness.send({ id: fork.id, result: threadResult("side-thread") });
        const inject = await waitForRequest("thread/inject_items");
        harness.send({ id: inject.id, result: {} });

        if (written) {
          const turnStart = await waitForRequest("turn/start");
          controller.abort("side-start-cancelled");
          const interrupt = await waitForRequest("turn/interrupt");
          expect(interrupt.params).toEqual({ threadId: "side-thread", turnId: "" });
          harness.send({ id: turnStart.id, result: turnStartResult("turn-1") });
          harness.send(
            interruptFails
              ? { id: interrupt.id, error: { code: -32_000, message: "side interrupt failed" } }
              : { id: interrupt.id, result: {} },
          );
        } else {
          controller.abort("side-start-cancelled");
        }

        if (!interruptFails) {
          if (written) {
            const terminals = await waitForRequest("thread/backgroundTerminals/list");
            expect(terminals.params).toEqual({ threadId: "side-thread" });
            harness.send({ id: terminals.id, result: { data: [] } });
          }
          const unsubscribe = await waitForRequest("thread/unsubscribe");
          harness.send(
            unsubscribeFails
              ? { id: unsubscribe.id, error: { code: -32_000, message: "side unsubscribe failed" } }
              : { id: unsubscribe.id, result: {} },
          );
        }
        const error = await failure;
        if (written) {
          const turnStart =
            requests.mock.results[
              requests.mock.calls.findIndex(([method]) => method === "turn/start")
            ];
          assert(turnStart?.type === "return", "Expected the native turn/start request promise");
          const primaryError = await turnStart.value.catch((reason: unknown) => reason);
          expect(primaryError).toMatchObject({
            message: "turn/start aborted: side-start-cancelled",
            cause: "side-start-cancelled",
            reason: "aborted",
            mayHaveWritten: true,
          });
          if (interruptFails) {
            assert(
              error instanceof AggregateError,
              "Expected cancellation and native cleanup failures",
            );
            expect(error.cause).toBe(primaryError);
            expect(error.errors).toHaveLength(2);
            expect(error.errors[0]).toBe(primaryError);
            expect(error.errors[1]).toMatchObject({
              message:
                "Codex /btw cleanup could not confirm the side turn stopped; background terminals may still be running.",
            });
            expect(error.message).toContain("turn/start aborted: side-start-cancelled");
            expect(error.message).toContain("could not confirm the side turn stopped");
          } else {
            expect(error).toBe(primaryError);
          }
        } else {
          expect(error).toMatchObject({
            name: "CodexThreadPolicyHandoffError",
            outcome: "acknowledged",
            cause: "side-start-cancelled",
          });
        }
        expect(harness.writes.map((write) => JSON.parse(write).method)).toEqual([
          "thread/fork",
          "thread/inject_items",
          ...(written ? ["turn/start", "turn/interrupt"] : []),
          ...(written && !interruptFails ? ["thread/backgroundTerminals/list"] : []),
          ...(!interruptFails ? ["thread/unsubscribe"] : []),
        ]);
        expect(harness.stdinDestroyed).toBe((interruptFails && !peerRetained) || unsubscribeFails);
        if (peerRetained) {
          expect(retireClient).toHaveBeenCalledExactlyOnceWith(harness.client);
        }
      } finally {
        controller.abort();
        harness.client.close();
        await failure;
      }
    },
  );

  it.each([false, true])(
    "settles side background-terminal cleanup before cancellation returns (terminal and projector failure: %s)",
    async (terminationFails) => {
      const controller = new AbortController();
      const client = createFakeClient({ completeTurn: false });
      const request = client.request.getMockImplementation()!;
      const turnWaiting = createDeferred<void>();
      const waits = vi.spyOn(CodexEphemeralTurn.prototype, "wait");
      CodexEphemeralTurn.prototype.wait = function (this: CodexEphemeralTurn, ...args) {
        const pending = waits.apply(this, args);
        turnWaiting.resolve();
        return pending;
      };
      const terminalCleanup = vi.spyOn(clientCleanup, "terminateCodexBackgroundTerminals");
      const finalize = vi.spyOn(CodexNativeToolLifecycleProjector.prototype, "finalizeActive");
      const projectorError = new Error("side projector finalization failed");
      if (terminationFails) {
        finalize.mockImplementationOnce(() => {
          throw projectorError;
        });
      }
      const releaseTermination = createDeferred<void>();
      const terminationStarted = createDeferred<void>();
      const terminals = new Map([
        ["parent-thread", new Set([10])],
        ["side-thread", new Set([20])],
      ]);
      client.request.mockImplementation(async (method, requestParams, requestOptions) => {
        if (method === "thread/backgroundTerminals/list") {
          const { threadId } = requestParams as { threadId: string };
          return { data: [...(terminals.get(threadId) ?? [])].map((processId) => ({ processId })) };
        }
        if (method === "thread/backgroundTerminals/terminate") {
          const { threadId, processId } = requestParams as { threadId: string; processId: number };
          terminationStarted.resolve();
          await releaseTermination.promise;
          if (!terminationFails) {
            terminals.get(threadId)?.delete(processId);
          }
          return { success: !terminationFails };
        }
        return await request(method, requestParams, requestOptions);
      });
      acquireClient.mockResolvedValue(client);
      let settled = false;
      const run = runSide({ opts: { abortSignal: controller.signal } })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      try {
        const waiting = await Promise.race([
          turnWaiting.promise.then(() => true),
          terminationStarted.promise.then(() => false),
          run.then(() => false),
        ]);
        if (!waiting) {
          // Cleanup can be waiting on our terminal gate before the run settles.
          releaseTermination.resolve();
          throw new Error("Side question settled before waiting for its native turn", {
            cause: await run,
          });
        }
        expect(client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true);
        controller.abort();
        await Promise.race([
          terminationStarted.promise,
          run.then((result) => {
            if (result instanceof Error) {
              throw result;
            }
            throw new Error("Side question settled before cancellation cleanup was ready", {
              cause: result,
            });
          }),
        ]);
        expect(client.request).toHaveBeenCalledWith(
          "thread/backgroundTerminals/terminate",
          { threadId: "side-thread", processId: 20 },
          expect.any(Object),
        );
        expect(settled).toBe(false);
        expect(client.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(
          false,
        );
        releaseTermination.resolve();
        const error = await run;
        const wait = waits.mock.results[0];
        assert(wait?.type === "return", "Expected the native side-turn completion promise");
        const primaryError = await wait.value.catch((reason: unknown) => reason);
        expect(primaryError).toMatchObject({ message: "Codex /btw was aborted." });
        if (terminationFails) {
          const cleanup = terminalCleanup.mock.results[0];
          assert(cleanup?.type === "return", "Expected the native terminal cleanup promise");
          const cleanupError = await cleanup.value.catch((reason: unknown) => reason);
          expect(cleanupError).toMatchObject({
            message: expect.stringContaining("background-terminal cleanup failed"),
          });
          assert(
            error instanceof AggregateError,
            "Expected cancellation and terminal cleanup failures",
          );
          expect(error.cause).toBe(primaryError);
          expect(error.errors).toHaveLength(3);
          expect(error.errors[0]).toBe(primaryError);
          expect(error.errors[1]).toBe(cleanupError);
          expect(error.message).toContain("Codex /btw was aborted.");
          expect(error.message).toContain("background-terminal cleanup failed");
          expect(error.errors[2]).toBe(projectorError);
          expect(error.message).toContain(projectorError.message);
        } else {
          expect(error).toBe(primaryError);
        }
        expect(finalize).toHaveBeenCalledOnce();
        expect(terminals.get("parent-thread")).toEqual(new Set([10]));
        expect(terminals.get("side-thread")).toEqual(new Set(terminationFails ? [20] : []));
        expect(client.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(
          !terminationFails,
        );
      } finally {
        releaseTermination.resolve();
        controller.abort();
        await run;
        waits.mockRestore();
        terminalCleanup.mockRestore();
        finalize.mockRestore();
      }
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
