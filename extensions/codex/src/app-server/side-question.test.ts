import "./side-question.test-support.js";
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
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-types";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as clientCleanup from "./attempt-client-cleanup.js";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import { CodexEphemeralTurn } from "./ephemeral-turn.js";
import { CodexNativeToolLifecycleProjector } from "./event-projector-native-tool-lifecycle.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createClientHarness, createCodexTestModel } from "./test-support.js";

const {
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
  runSideQuestionWithManagedWebSearchCall,
  runCodexAppServerSideQuestionImpl,
  createFakeClient,
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

type SelectionRetryParams = import("./side-question.test-support.js").SelectionRetryParams;

function supervisionConnectionFingerprint(): string {
  return buildCodexAppServerConnectionFingerprint(
    resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: { supervision: { enabled: true } },
    }),
  );
}

function createPendingClient({ interrupt = true } = {}) {
  const client = createFakeClient({ completeTurn: false });
  client.request.mockImplementation(async (method: string) => {
    if (method === "thread/fork") {
      return threadResult("side-thread");
    }
    if (method === "turn/start") {
      return turnStartResult("turn-1");
    }
    if (
      method === "thread/inject_items" ||
      method === "thread/unsubscribe" ||
      (interrupt && method === "turn/interrupt")
    ) {
      return {};
    }
    throw new Error(`unexpected request: ${method}`);
  });
  return client;
}

function mockCall(mock: ReturnType<typeof vi.fn>, index = 0): unknown[] {
  const call = mock.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call;
}

async function handleClientRequestWhenReady(
  client: ReturnType<typeof createFakeClient>,
  request: Parameters<ReturnType<typeof createFakeClient>["handleRequest"]>[0],
  assertHandled: (response: unknown) => void = (response) => expect(response).not.toBeUndefined(),
): Promise<unknown> {
  let response: unknown;
  await vi.waitFor(async () => {
    response = await client.handleRequest(request);
    assertHandled(response);
  });
  return response;
}

async function startClientRequestWhenReady(
  client: ReturnType<typeof createFakeClient>,
  request: Parameters<ReturnType<typeof createFakeClient>["handleRequest"]>[0],
  started: Promise<void>,
): Promise<void> {
  await vi.waitFor(async () => {
    const requestResult = client.handleRequest(request);
    void requestResult.catch(() => undefined);
    const state = await Promise.race([
      started.then(() => "started" as const),
      requestResult.then(
        () => "unhandled" as const,
        () => "unhandled" as const,
      ),
    ]);
    expect(state).toBe("started");
  });
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function codexHookCommand(config: unknown, key: string) {
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

function nativeCommandItem(
  id: string,
  status: "inProgress" | "completed",
  durationMs: number | null,
) {
  return {
    type: "commandExecution",
    id,
    command: "git status --short",
    cwd: "/tmp/workspace",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: status === "completed" ? "" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs,
  };
}

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
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: previous.sessionId, updatedAt: 1 },
    });
    const sessionEntry = await patchSessionEntry({
      ...scope,
      update: () => ({ sessionId: current.sessionId }),
    });
    if (!sessionEntry) {
      throw new Error("Expected the committed successor session");
    }
    const parent = { threadId: "parent-thread", cwd: "/tmp/workspace" };
    const persistedBindings = createCodexTestBindingStore();
    await persistedBindings.mutate(previous, { kind: "set", binding: parent });
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockImplementationOnce(async () => {
      expect(persistedBindings.read(current)).toEqual(parent);
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });
      return client;
    });

    const operation = runCodexAppServerSideQuestionImpl(
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
    const client = createFakeClient({ completeTurn: false });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    const controller = new AbortController();
    let outcome: unknown;
    const run = runCodexAppServerSideQuestion(
      sideParams({ opts: { abortSignal: controller.signal } }),
    ).catch((error: unknown) => {
      outcome = error;
    });
    try {
      await vi.waitFor(() =>
        expect(client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true),
      );
      client.close(new Error("app-server transport disconnected"));
      await vi.waitFor(
        () =>
          expect(outcome).toEqual(
            expect.objectContaining({
              message: expect.stringContaining("closed"),
            }),
          ),
        { timeout: 200 },
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
    const client = createFakeClient({ completeTurn: false });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    let toolSignal: AbortSignal | undefined;
    toolExecuteMock.mockImplementation((_callId: string, _args: unknown, signal?: AbortSignal) => {
      toolSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("tool cancelled")), {
          once: true,
        });
      });
    });
    const run = runCodexAppServerSideQuestion(sideParams());
    await vi.waitFor(() =>
      expect(client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true),
    );
    const requestController = new AbortController();
    const request = client.handleRequest(
      {
        id: "cancelled-side-tool",
        method: "item/tool/call",
        params: {
          ...codexTestTurnIds("side-thread"),
          callId: "tool-1",
          tool: "wiki_status",
          arguments: {},
        },
      },
      requestController.signal,
    );
    try {
      await vi.waitFor(() => expect(toolSignal).toBeDefined());
      requestController.abort(new Error("app-server request deadline"));
      await vi.waitFor(() => expect(toolSignal?.aborted).toBe(true), { timeout: 200 });
    } finally {
      client.emit(turnCompleted("side-thread", "turn-1", "Finished answer."));
      await run;
      await request;
    }
  });

  it("returns billed usage from the side thread without changing its answer", async () => {
    const client = createFakeClient({ completeTurn: false });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    const run = runCodexAppServerSideQuestion(sideParams());
    await vi.waitFor(() =>
      expect(client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true),
    );
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
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    createOpenClawCodingToolsMock.mockReturnValue([
      ...createOpenClawCodingToolsMock.getMockImplementation()!(),
      {
        name: "session_status",
        description: "Show session status",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: toolExecuteMock,
      },
    ]);

    const result = await runCodexAppServerSideQuestion(
      sideParams({
        question: " Describe this image. ",
        images: [{ type: "image", data, mimeType: "image/png" }],
        cfg: {
          agents: { defaults: { userTimezone: "America/Los_Angeles" } },
        } as never,
        messageChannel: "discord",
        messageProvider: "discord-voice",
        chatId: "discord-native-room",
        chatType: "channel",
        sessionKey: "agent:main:conversation",
        sandboxSessionKey: "agent:main:runtime-policy",
        messageActionTurnCapability: "turn-capability-1",
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
      }),
      { runtimeModelId: "codex-side-execution-model" },
    );

    expect(result).toEqual({ text: "Side answer." });
    expect(mockCall(getSharedCodexAppServerClientMock)[0]).toMatchObject({
      preparedAuth: {
        kind: "profile",
        profileId: "openai:work",
        store: expect.objectContaining({
          profiles: expect.objectContaining({ "openai:work": expect.any(Object) }),
        }),
      },
    });
    expect(mockCall(getSharedCodexAppServerClientMock)[0]).not.toHaveProperty("authProfileId");
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

    const [toolOptions] = mockCall(createOpenClawCodingToolsMock);
    expect(toolOptions).toHaveProperty("agentDir", "/tmp/agent");
    expect(toolOptions).toHaveProperty("workspaceDir", "/tmp/workspace");
    expect(toolOptions).toHaveProperty("sessionId", "session-1");
    expect(toolOptions).toHaveProperty("modelProvider", "openai");
    expect(toolOptions).toHaveProperty("modelId", "gpt-5.5");
    expect(toolOptions).toHaveProperty("messageProvider", "discord");
    expect(toolOptions).toHaveProperty("toolPolicyMessageProvider", "discord-voice");
    expect(toolOptions).toHaveProperty("chatType", "channel");
    expect(toolOptions).toHaveProperty("currentChannelId", "voice-room");
    expect(toolOptions).toHaveProperty("nativeChannelId", "discord-native-room");
    expect(toolOptions).toMatchObject({
      agentAccountId: "account-1",
      sessionKey: "agent:main:runtime-policy",
      runSessionKey: "agent:main:conversation",
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
    });
    expect(toolOptions).toHaveProperty("requireExplicitMessageTarget", true);
  });

  it.each([
    { boundary: "recorded root", sessionRoot: "/tmp/workspace/guarded" },
    { boundary: "agent workspace", sessionRoot: undefined },
  ])("clamps stale full access to the guarded session $boundary", async ({ sessionRoot }) => {
    const root = sessionRoot ?? "/tmp/workspace";
    readCodexAppServerBindingMock.mockReturnValue({
      threadId: "parent-thread",
      cwd: "/tmp/outside-session-root",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          sessionKey: "agent:main:session-1",
          sessionEntry: {
            sessionId: "session-1",
            sessionFile: "/tmp/session-1.jsonl",
            updatedAt: 1,
            permissionMode: "guarded",
            ...(sessionRoot ? { sessionRoot } : {}),
          },
        }),
      ),
    ).resolves.toEqual({ text: "Side answer." });

    expect(mockCall(client.request)[1]).toMatchObject({
      cwd: root,
      runtimeWorkspaceRoots: [root],
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    expect(mockCall(createOpenClawCodingToolsMock)[0]).toMatchObject({
      exec: { mode: "ask" },
      sessionPermissionPolicy: { mode: "guarded", root },
    });
  });

  it("returns an explicit unsupported decline for ordinary MCP input", async () => {
    const approvalSpy = vi.spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest");
    const client = createFakeClient({ completeTurn: false });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    const run = runCodexAppServerSideQuestion(sideParams());
    await vi.waitFor(() =>
      expect(client.request.mock.calls.map(([method]) => method)).toContain("turn/start"),
    );

    const item = {
      type: "mcpToolCall",
      id: "side-mcp",
      server: "configured-server",
      tool: "raw-tool",
      arguments: { query: "side query" },
      status: "inProgress",
    };
    client.emit({
      method: "item/started",
      params: { threadId: "side-thread", turnId: "turn-1", item },
    });

    await expect(
      handleClientRequestWhenReady(client, {
        id: "side-elicitation",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "side-thread",
          turnId: "turn-1",
          serverName: "forms",
          mode: "form",
          message: "Enter a value",
          requestedSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      }),
    ).resolves.toEqual({
      action: "decline",
      content: null,
      _meta: {
        message: "OpenClaw Codex side questions do not support interactive MCP input.",
      },
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
      client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
      client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
      await expect(run).resolves.toEqual({ text: "Side answer." });
    }
    expect(correlate?.(item.server)).toBeUndefined();
  });

  it("routes a remote-exec side question through the injected sandbox environment", async () => {
    const client = createPendingClient();
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "environment/add") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          client.emit(agentDelta("side-thread", "turn-1", "Remote answer."));
          client.emit(turnCompleted("side-thread", "turn-1", "Remote answer."));
        });
        return turnStartResult("turn-1");
      }
      return baseRequest(method, requestParams);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    const sandbox = {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec" as const,
      containerWorkdir: "/remote/synced-workspace",
    };

    await expect(runCodexAppServerSideQuestion(sideParams({ sandbox }))).resolves.toEqual({
      text: "Remote answer.",
    });

    const environmentAdd = client.request.mock.calls.find(
      ([method]) => method === "environment/add",
    );
    const environment = environmentAdd?.[1] as
      | { environmentId?: string; execServerUrl?: string }
      | undefined;
    expect(environment?.environmentId).toMatch(/^openclaw-sandbox-/u);
    expect(environment?.execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/u);
    const forkParams = client.request.mock.calls.find(([method]) => method === "thread/fork")?.[1];
    expect(forkParams).toMatchObject({ cwd: "/remote/synced-workspace" });
    expect(forkParams).not.toHaveProperty("sandbox");
    const turnParams = client.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(turnParams).toMatchObject({
      cwd: "/remote/synced-workspace",
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      environments: [
        {
          environmentId: environment?.environmentId,
          cwd: "/remote/synced-workspace",
        },
      ],
    });
  });

  it("rejects paired-node side questions before acquiring authority", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
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
      runCodexAppServerSideQuestion(
        sideParams({
          sandbox,
          hostCapabilities: { ...TEST_HOST_CAPABILITIES, requestApproval },
        }),
        { runtime: { nodes: { openDuplex } } as never },
      ),
    ).rejects.toThrow(
      "Normal Codex turns are supported on nodes, but /btw is not yet bound to the active placement.",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
    expect(openDuplex).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
    expect(createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("routes a side question only through the client selected for its fork", async () => {
    const initialClient = createFakeClient();
    const replacementClient = createPendingClient();
    const baseRequest = replacementClient.request.getMockImplementation()!;
    replacementClient.request.mockImplementation(
      async (method: string, requestParams?: unknown) => {
        if (method === "turn/start") {
          queueMicrotask(() => {
            initialClient.emit(turnCompleted("side-thread", "turn-1", "Stale client answer."));
            replacementClient.emit(agentDelta("side-thread", "turn-1", "Replacement answer."));
            replacementClient.emit(turnCompleted("side-thread", "turn-1", "Replacement answer."));
          });
          return turnStartResult("turn-1");
        }
        return baseRequest(method, requestParams);
      },
    );
    getSharedCodexAppServerClientMock.mockResolvedValue(initialClient);
    withLeasedCodexAppServerClientStartSelectionRetryMock.mockImplementationOnce(
      async (params: SelectionRetryParams) => {
        expect(params.lease.client).toBe(initialClient);
        params.lease.client = replacementClient;
        params.onClientChange(replacementClient);
        return await params.run(replacementClient, () => ({
          timeoutMs: params.options.timeoutMs ?? 60_000,
          signal: params.options.abandonSignal,
          assertCurrent: () => {},
        }));
      },
    );

    await expect(runCodexAppServerSideQuestion(sideParams())).resolves.toEqual({
      text: "Replacement answer.",
    });

    // A finished route cannot dispatch retained tool requests on either physical client.
    for (const client of [initialClient, replacementClient]) {
      await expect(
        client.handleRequest({
          id: "late-side-tool",
          method: "item/tool/call",
          params: {
            ...codexTestTurnIds("side-thread"),
            callId: "late-tool",
            tool: "wiki_status",
            arguments: {},
          },
        }),
      ).resolves.toBeUndefined();
    }
    expect(toolExecuteMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      metadata: "Platform",
      thinking: "off",
      rawModel: "configured-alias",
      supported: ["none", "low", "medium", "high", "xhigh", "max"],
      expected: "none",
    },
    { metadata: "unknown", thinking: "ultra", supported: undefined, expected: "ultra" },
  ] as const)(
    "sends $thinking with $metadata metadata to the side-question request boundary",
    async (scenario) => {
      const { thinking, supported, expected } = scenario;
      const requestedModel = "rawModel" in scenario ? scenario.rawModel : "gpt-5.6-sol";
      const client = createFakeClient();
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      const compat: ModelCompatConfig | undefined = supported
        ? { supportedReasoningEfforts: [...supported] }
        : undefined;
      const params = sideParams({
        model: requestedModel,
        resolvedThinkLevel: thinking,
        runtimeModel: {
          ...createCodexTestModel(),
          id: "gpt-5.6-sol",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          compat,
        },
      });
      params.preparedRuntimeAuth = platformPreparedRuntimeAuth("platform-test-key");
      params.authProfileId = undefined;
      params.authProfileIdSource = undefined;
      isCodexAppServerNativeAuthProfileMock.mockReturnValue(false);
      params.preparedRuntimeAuth.plan.modelRoute!.modelId = params.model;

      await expect(runCodexAppServerSideQuestion(params)).resolves.toEqual({
        text: "Side answer.",
      });

      expect(getSharedCodexAppServerClientMock).toHaveBeenCalledWith(
        expect.objectContaining({ preparedAuth: { kind: "api-key", apiKey: "platform-test-key" } }),
      );
      expect(mockCall(getSharedCodexAppServerClientMock)[0]).not.toHaveProperty("authProfileId");
      expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterThinkingLevel: thinking,
          requesterModel: { provider: "openai", model: "gpt-5.6-sol" },
        }),
      );
      const turnStartCall = client.request.mock.calls.find(([method]) => method === "turn/start");
      expect(turnStartCall?.[1]).toMatchObject({
        threadId: "side-thread",
        model: requestedModel,
        effort: expected,
        collaborationMode: {
          settings: { model: requestedModel, reasoning_effort: expected },
        },
      });
    },
  );

  it("rejects a Platform plan before binding OAuth can fill missing prepared auth", async () => {
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "openai",
          model: "gpt-5.6",
          runtimeModel: {
            provider: "openai",
            id: "gpt-5.6",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          } as never,
          authProfileId: undefined,
          authProfileIdSource: undefined,
          preparedRuntimeAuth: platformPreparedRuntimeAuth(),
        }),
      ),
    ).rejects.toThrow("Prepared Codex API-key route is missing its resolved API key");

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
    expect(isCodexAppServerNativeAuthProfileMock).not.toHaveBeenCalled();
  });

  it("rejects an unprofiled subscription plan before native account inference", async () => {
    isCodexAppServerNativeAuthProfileMock.mockReturnValue(false);
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          authProfileId: undefined,
          authProfileIdSource: undefined,
        }),
      ),
    ).rejects.toThrow(
      "Prepared Codex subscription route requires a scoped native OAuth or token profile",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
    expect(isCodexAppServerNativeAuthProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: undefined, authProfileStore: expect.any(Object) }),
    );
  });

  it("uses the default supervision runtime, native auth, and exact bound model pair", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockReturnValue({
      threadId: "parent-thread",
      connectionScope: "supervision",
      supervisionSourceThreadId: "source-thread",
      cwd: "/tmp/workspace",
      model: "gpt-5.5",
      modelProvider: "openai",
      appServerRuntimeFingerprint: supervisionConnectionFingerprint(),
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          provider: "anthropic",
          model: "claude-opus-4-6",
          runtimeModel: {
            id: "claude-opus-4-6",
            provider: "anthropic",
            compat: { supportsTools: false, supportedReasoningEfforts: ["none", "high"] },
          } as never,
          resolvedThinkLevel: "off",
          authProfileId: "openai:outer",
        }),
        { pluginConfig: { supervision: { enabled: true } } },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    expect(getSharedCodexAppServerClientMock).toHaveBeenCalledWith(
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
    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "openai", modelId: "gpt-5.5" }),
    );
  });

  it("cleans up a supervised fork that returns a different native model pair", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockReturnValue({
      threadId: "parent-thread",
      connectionScope: "supervision",
      supervisionSourceThreadId: "source-thread",
      cwd: "/tmp/workspace",
      model: "gpt-5.4",
      modelProvider: "openai",
      appServerRuntimeFingerprint: supervisionConnectionFingerprint(),
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { supervision: { enabled: true } },
      }),
    ).rejects.toThrow("did not preserve its native model and provider");

    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
    ]);
  });

  it.each(["ok", "binding-changed"])(
    "projects bound ask policy before side-thread forks: %s",
    async (outcome) => {
      const approvalSpy = vi.spyOn(elicitationBridge, "routeCodexAppServerElicitationRequest");
      const rejectsReplay = outcome === "binding-changed";
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
      const client = createFakeClient({ completeTurn: rejectsReplay });
      const baseRequest = client.request.getMockImplementation()!;
      client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
        if (method === "app/installed") {
          return {
            apps: ["ask-app", "unbound-app"].map((id) => ({
              id,
              runtimeName: id,
              enabled: true,
              callable: true,
            })),
          };
        }
        if (method === "app/read") {
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
        }
        if (method === "config/read") {
          if (outcome === "binding-changed") {
            readCodexAppServerBindingMock.mockReturnValue({ threadId: "replacement-thread" });
          }
          return { config: { apps: { "ask-app": nativeAppConfig } }, layers: [] };
        }
        if (method === "config/batchWrite" || method === "config/value/write") {
          throw new Error("side-question admission cannot write saved app settings");
        }
        return baseRequest(method, requestParams);
      });
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      readCodexAppServerBindingMock.mockReturnValue({
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

      const run = runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { appServer: { mode: "guardian" } },
      });
      if (rejectsReplay) {
        await expect(run).rejects.toThrow("binding changed before fork");
        const methods = client.request.mock.calls.map(([method]) => method);
        expect(methods).not.toContain("config/batchWrite");
        expect(methods).not.toContain("config/value/write");
        expect(methods).not.toContain("thread/fork");
        return;
      }
      await vi.waitFor(() =>
        expect(client.request.mock.calls.map(([method]) => method)).toContain("turn/start"),
      );
      try {
        await handleClientRequestWhenReady(client, {
          id: "side-approval-policy",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "side-thread",
            turnId: "turn-1",
            serverName: "forms",
            mode: "form",
            message: "Enter a value",
            requestedSchema: { type: "object", properties: { value: { type: "string" } } },
          },
        });
        const policy = approvalSpy.mock.calls.at(-1)?.[0].pluginAppPolicyContext;
        expect(Object.keys(policy?.apps ?? {}).toSorted()).toEqual([
          "ask-app",
          "auto-app",
          "false-app",
          "true-app",
        ]);
        expect(policy?.pluginAppIds.ask).toEqual(["ask-app"]);
      } finally {
        client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
        client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        await expect(run).resolves.toEqual({ text: "Side answer." });
      }

      const methods = client.request.mock.calls.map(([method]) => method);
      expect(methods.indexOf("app/read")).toBeLessThan(methods.indexOf("thread/fork"));
      expect(methods.filter((method) => method === "config/read")).toHaveLength(1);
      expect(methods).not.toContain("config/batchWrite");
      expect(methods).not.toContain("config/value/write");
      expect(nativeAppConfig).toEqual(savedAppConfig);
      const forkParams = client.request.mock.calls.find(
        ([method]) => method === "thread/fork",
      )?.[1] as Record<string, unknown> | undefined;
      expect(forkParams?.approvalsReviewer).toBe("auto_review");
      const config = forkParams?.config as Record<string, unknown> | undefined;
      expect(config).not.toHaveProperty("approvals_reviewer");
      expect(config?.["features.code_mode"]).toBe(true);
      expect(config?.apps).toEqual({
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        "ask-app": {
          enabled: true,
          approvals_reviewer: "user",
          destructive_enabled: true,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
          links: { account: { approvals_reviewer: "user", default_tools_approval_mode: "auto" } },
          tools: { write: { approval_mode: "auto" } },
        },
        "auto-app": {
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: true,
        },
        "false-app": {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
        },
        "true-app": {
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: true,
        },
      });
    },
  );

  it("disables hosted search when side-question sender policy removes managed web_search", async () => {
    createOpenClawCodingToolsMock.mockImplementation((options: { senderId?: string }) =>
      options.senderId === "restricted-sender"
        ? []
        : [
            {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object", properties: {}, additionalProperties: true },
              execute: toolExecuteMock,
            },
          ],
    );

    const { forkConfig } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({ senderId: "restricted-sender" }),
      { preserveToolFactory: true },
    );

    expect(forkConfig).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("rejects side questions before forking when the tool allowlist excludes native tools", async () => {
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          messageChannel: "telegram",
          messageProvider: "telegram",
          senderId: "restricted-sender",
          toolsAllow: ["message"],
        }),
      ),
    ).rejects.toThrow(
      "Codex-native /btw side-question mode is unavailable because the effective tool policy restricts Codex native tools for this session.",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
    expect(resolveCodexProviderWebSearchSupportForClientMock).not.toHaveBeenCalled();
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
    createOpenClawCodingToolsMock.mockImplementation((options) => {
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
      return [
        {
          name: "web_search",
          description: "Search the web",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          execute: toolExecuteMock,
        },
        ...(webFetchTool ? [webFetchTool] : []),
      ];
    });
    const fetchMock = vi.fn(
      async () =>
        new Response("permitted", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { toolResponse } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({
        cfg: {
          tools: {
            web: {
              search: { openaiCodex: { allowedDomains: testCase.allowedDomains } },
              fetch: { cacheTtlMinutes: 0 },
            },
          },
        } as never,
      }),
      {
        preserveToolFactory: true,
        toolName: "web_fetch",
        toolArguments: { url: testCase.url },
      },
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

  it("disables search for side forks when a managed provider is selected", async () => {
    const { forkConfig, result, toolResponse } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({
        cfg: {
          tools: {
            web: {
              search: {
                provider: "brave",
              },
            },
          },
        } as never,
      }),
    );

    expect(result).toEqual({ text: "Search answer." });
    expect(forkConfig).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
    expect(toolResponse).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: web_search" }],
    });
    expect(toolExecuteMock).not.toHaveBeenCalled();
    expect(resolveCodexProviderWebSearchSupportForClientMock).not.toHaveBeenCalled();
  });

  it("checks /btw native execution against the runtime-policy session", async () => {
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          cfg: {
            agents: {
              defaults: { sandbox: { mode: "non-main", scope: "agent" } },
              list: [{ id: "main" }],
            },
          } as never,
          sessionKey: "agent:main:main",
          sandboxSessionKey: "agent:main:whatsapp:personal:direct:15555550123",
        }),
      ),
    ).rejects.toThrow(
      "Codex-native /btw side-question mode is unavailable because OpenClaw sandboxing is active for this session.",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it("uses the retained agent for an unscoped explicit-roster side question", async () => {
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          agentId: "alpha",
          cfg: {
            tools: { exec: { host: "gateway" } },
            agents: {
              entries: {
                alpha: { tools: { exec: { host: "node", node: "worker-1" } } },
                beta: {},
              },
            },
          } as never,
          sessionKey: "node-session",
        }),
      ),
    ).rejects.toThrow(
      "Codex-native /btw side-question mode is unavailable because OpenClaw exec host=node is active for this session.",
    );

    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it.each(["caller cancellation"] as const)(
    "revokes native hook authority on close while projecting the final %s",
    async (outcome) => {
      const turnStarted = createDeferred<void>();
      const client = createFakeClient({ completeTurn: false, onTurnStart: turnStarted.resolve });
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      const projecting = createDeferred<void>();
      const finishProjection = createDeferred<void>();
      const controller = new AbortController();
      const run = runCodexAppServerSideQuestion(
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
        await Promise.race([
          turnStarted.promise,
          settled.then(() => {
            throw new Error("Side-question fixture ended before turn/start", { cause: runError });
          }),
        ]);
        const fork = client.request.mock.calls.find(([method]) => method === "thread/fork")?.[1];
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
        if (outcome === "caller cancellation") {
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
          expect(client.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(
            false,
          );
          expect(client.request).toHaveBeenCalledWith(
            "thread/backgroundTerminals/list",
            { threadId: "side-thread" },
            expect.any(Object),
          );
        } else {
          finishProjection.resolve();
          await expect(run).resolves.toEqual({ text: "Side answer." });
        }
      } finally {
        controller.abort("fixture cleanup");
        finishProjection.resolve();
        await settled;
      }
    },
  );

  it.each([true])("keeps side hooks after listener failure: %s", async (failed) => {
    if (failed) {
      vi.spyOn(Server.prototype, "listen").mockImplementationOnce(function (this: Server) {
        queueMicrotask(() => this.emit("error", new Error("fixture side listener unavailable")));
        return this;
      });
    }
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
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "thread/fork") {
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
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
          client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        });
        return turnStartResult("turn-1");
      }
      return baseRequest(method, requestParams);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideLoopRelayParams({
          hostCapabilities: host.hostCapabilities,
          sessionKey: "agent:main:session-1",
          sessionEntry: {
            sessionId: "session-1",
            updatedAt: 1,
            permissionMode: "guarded",
            sessionRoot: "/tmp/workspace",
          },
          messageChannel: "discord",
          messageProvider: "discord-voice",
          currentChannelId: "discord:voice-room",
          opts: { runId: "run-side-1" },
        }),
        { nativeHookRelay: { enabled: true, hookTimeoutSec: 9 } },
      ).finally(() => {
        host.closeHost();
        host.closeAdmission();
      }),
    ).resolves.toEqual({ text: "Side answer." });

    expect(relayIdDuringFork).toBeDefined();
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-side-1" }),
    );
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayIdDuringFork!),
    ).toBeUndefined();
  });

  it("forwards side-thread command approvals through the active native hook relay", async () => {
    const turnStarted = createDeferred<void>();
    const client = createPendingClient();
    let relayIdDuringFork: string | undefined;
    handleCodexAppServerApprovalRequestMock.mockResolvedValueOnce({ decision: "decline" });
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "thread/fork") {
        const config = (requestParams as { config?: Record<string, unknown> }).config;
        relayIdDuringFork = extractRelayIdFromThreadConfig(config);
        return threadResult("side-thread");
      }
      if (method === "turn/start") {
        turnStarted.resolve();
        return turnStartResult("turn-1");
      }
      return baseRequest(method, requestParams);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const run = runCodexAppServerSideQuestion(
      sideLoopRelayParams({
        sessionKey: "agent:main:session-1",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: 1,
          permissionMode: "guarded",
          sessionRoot: "/tmp/workspace",
        },
        messageChannel: "discord",
        messageProvider: "discord-voice",
        opts: { runId: "run-side-approval" },
      }),
      { nativeHookRelay: { enabled: true } },
    );
    try {
      await Promise.race([
        turnStarted.promise,
        run.then(() => {
          throw new Error("Side question ended before accepting its turn");
        }),
      ]);
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
      expect(handleCodexAppServerApprovalRequestMock).toHaveBeenCalledTimes(1);
      const approvalArgs = handleCodexAppServerApprovalRequestMock.mock.calls[0]?.[0] as
        | {
            method?: string;
            requestParams?: Record<string, unknown>;
            threadId?: string;
            turnId?: string;
            paramsForRun?: { messageChannel?: string; messageProvider?: string };
            nativeHookRelay?: { relayId?: string; allowedEvents?: readonly string[] };
          }
        | undefined;
      expect(approvalArgs).toMatchObject({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds("side-thread"),
          itemId: "cmd-side",
          command: "/bin/bash -lc 'node -v'",
          cwd: "/tmp/workspace",
        },
        ...codexTestTurnIds("side-thread"),
        autoApprove: false,
        paramsForRun: {
          messageChannel: "discord",
          messageProvider: "discord-voice",
        },
      });
      expect(approvalArgs?.nativeHookRelay).toMatchObject({
        relayId: relayIdDuringFork,
        allowedEvents: expect.arrayContaining(["pre_tool_use"]),
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
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), { nativeHookRelay: { enabled: false } }),
    ).resolves.toEqual({ text: "Side answer." });

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
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
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
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(forkParams).not.toHaveProperty("sandbox");
    expect(config).toMatchObject({
      "features.network_proxy.enabled": true,
      default_permissions: "side-proxy",
      permissions: {
        "side-proxy": {
          filesystem: {
            ":minimal": "read",
            ":project_roots": { ".": "write" },
          },
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
    {
      name: "explicit native OpenAI",
      provider: "openai",
      model: "gpt-5.5",
      boundModel: "local-model",
      boundProvider: "lmstudio",
      expectedModel: "gpt-5.5",
      local: false,
    },
  ])("preserves side-fork model ownership for $name", async (scenario) => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockReturnValue({
      ...readCodexAppServerBindingMock(),
      model: scenario.boundModel,
      modelProvider: scenario.boundProvider,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({ provider: scenario.provider, model: scenario.model }),
        { pluginConfig: { appServer: { mode: "guardian", codeModeOnly: true } } },
      ),
    ).resolves.toEqual({ text: "Side answer." });
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

  it("emits a buffered native pre-tool failure when side turn startup fails", async () => {
    const client = createPendingClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    let relayId: string | undefined;
    let reportPreToolUseFailure:
      | NonNullable<NativeHookRelayRegistrationHandle["onPreToolUseFailure"]>
      | undefined;
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "thread/fork") {
        relayId = extractRelayIdFromThreadConfig(
          (requestParams as { config?: Record<string, unknown> }).config,
        );
        return threadResult("side-thread");
      }
      if (method === "turn/start") {
        if (!relayId) {
          throw new Error("Expected native hook relay id");
        }
        reportPreToolUseFailure =
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
            relayId,
          )?.onPreToolUseFailure;
        throw new Error("side turn start exploded");
      }
      return baseRequest(method, requestParams);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await expect(
        runCodexAppServerSideQuestion(sideLoopRelayParams(), {
          nativeHookRelay: { enabled: true },
        }),
      ).rejects.toThrow("side turn start exploded");
      await reportPreToolUseFailure?.({
        toolName: "exec",
        toolCallId: "side-turn-start-failure-tool",
        disposition: "failed",
        durationMs: 5,
      });
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(diagnosticEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.error",
        toolCallId: "side-turn-start-failure-tool",
        terminalReason: "failed",
      }),
    );
  });

  it("coalesces a native pre-tool failure that arrives during side turn cleanup", async () => {
    const client = createPendingClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    let reportPreToolUseFailure:
      | NonNullable<NativeHookRelayRegistrationHandle["onPreToolUseFailure"]>
      | undefined;
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "thread/fork") {
        const relayId = extractRelayIdFromThreadConfig(
          (requestParams as { config?: Record<string, unknown> }).config,
        );
        reportPreToolUseFailure =
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
            relayId,
          )?.onPreToolUseFailure;
        return threadResult("side-thread");
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          client.emit({
            method: "item/started",
            params: {
              ...codexTestTurnIds("side-thread"),
              item: nativeCommandItem("side-cleanup-failure-tool", "inProgress", null),
            },
          });
          client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
        });
        return turnStartResult("turn-1");
      }
      if (method === "thread/unsubscribe") {
        await reportPreToolUseFailure?.({
          toolName: "exec",
          toolCallId: "side-cleanup-failure-tool",
          disposition: "failed",
          durationMs: 5,
        });
        return {};
      }
      if (method === "turn/interrupt") {
        return {};
      }
      return baseRequest(method, requestParams);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await expect(
        runCodexAppServerSideQuestion(sideLoopRelayParams(), {
          nativeHookRelay: { enabled: true },
        }),
      ).resolves.toEqual({ text: "Side answer." });
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    expect(diagnosticEvents.filter((event) => event.type.startsWith("tool.execution."))).toEqual([
      expect.objectContaining({
        type: "tool.execution.started",
        toolCallId: "side-cleanup-failure-tool",
      }),
      expect.objectContaining({
        type: "tool.execution.error",
        toolCallId: "side-cleanup-failure-tool",
        errorCategory: "before_tool_call",
        terminalReason: "failed",
      }),
    ]);
  });

  it("bridges prepared restricted-profile tools into side threads", async () => {
    const preparedModelRuntime = {
      metadataSnapshot: {
        plugins: [
          {
            id: "profiled-plugin",
            contracts: { tools: ["wiki_status"] },
            toolMetadata: { wiki_status: { profiles: ["coding"] } },
          },
        ],
      },
    };
    createOpenClawCodingToolsMock.mockImplementation(
      (options: { preparedModelRuntime?: unknown }) =>
        options.preparedModelRuntime === preparedModelRuntime
          ? [
              {
                name: "wiki_status",
                description: "Check wiki status",
                parameters: {
                  type: "object",
                  properties: { topic: { type: "string" } },
                  required: ["topic"],
                  additionalProperties: false,
                },
                execute: toolExecuteMock,
              },
            ]
          : [],
    );
    const { result, toolResponse } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({ cfg: { tools: { profile: "coding" } }, preparedModelRuntime } as never),
      { preserveToolFactory: true, toolName: "wiki_status", toolArguments: { topic: "AGENTS.md" } },
    );
    expect(result).toEqual({ text: "Search answer." });
    expect(toolExecuteMock).toHaveBeenCalledOnce();
    const [callId, args, signal, options] = mockCall(toolExecuteMock);
    expect([callId, args, signal, options]).toEqual([
      "tool-1",
      { topic: "AGENTS.md" },
      expect.any(AbortSignal),
      undefined,
    ]);
    expect(toolResponse).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "tool output" }],
    });
  });

  it("normalizes hook channel ids for side-thread dynamic tool requests", async () => {
    const beforeToolCall = vi.fn((...args: unknown[]) => {
      expect(args[1]).toMatchObject({ channelId: "voice-room" });
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const { toolResponse } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({
        messageChannel: "discord",
        messageProvider: "discord-voice",
        currentChannelId: "discord:voice-room",
      }),
      { preserveToolFactory: true, toolName: "wiki_status", toolArguments: { topic: "AGENTS.md" } },
    );
    expect(toolResponse).toMatchObject({ success: true });
    expect(beforeToolCall).toHaveBeenCalledOnce();
    expect(toolExecuteMock).toHaveBeenCalledOnce();
    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ hookChannelId: "voice-room" }),
    );
  });

  it("omits computer control from side threads without a compaction owner", async () => {
    const client = createPendingClient();
    const computerExecute = vi.fn();
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "computer",
        description: "Control a desktop",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute: computerExecute,
      },
    ]);
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const run = runCodexAppServerSideQuestion(sideParams());
    const toolResponse = await handleClientRequestWhenReady(client, {
      id: 43,
      method: "item/tool/call",
      params: {
        ...codexTestTurnIds("side-thread"),
        callId: "computer-1",
        tool: "computer",
        arguments: { action: "screenshot" },
      },
    });
    client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
    client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
    await expect(run).resolves.toEqual({ text: "Side answer." });
    expect(computerExecute).not.toHaveBeenCalled();
    expect(toolResponse).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: computer" }],
    });
  });

  it("aborts active side tools before waiting for thread cleanup", async () => {
    const client = createPendingClient({ interrupt: false });
    let releaseUnsubscribe: (() => void) | undefined;
    const unsubscribePending = new Promise<void>((resolve) => {
      releaseUnsubscribe = resolve;
    });
    let toolAborted = false;
    let resolveToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      resolveToolStarted = resolve;
    });
    toolExecuteMock.mockImplementation(
      (_callId: string, _args: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          resolveToolStarted?.();
          signal?.addEventListener(
            "abort",
            () => {
              toolAborted = true;
              reject(new Error("side tool aborted"));
            },
            { once: true },
          );
        }),
    );
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "thread/unsubscribe") {
        await unsubscribePending;
        return {};
      }
      return baseRequest(method, requestParams);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const run = runCodexAppServerSideQuestion(sideParams());
    await startClientRequestWhenReady(
      client,
      {
        id: 42,
        method: "item/tool/call",
        params: {
          ...codexTestTurnIds("side-thread"),
          callId: "tool-1",
          tool: "wiki_status",
          arguments: {},
        },
      },
      toolStarted,
    );
    client.emit(turnCompleted("side-thread", "turn-1", "Finished answer."));
    await vi.waitFor(() =>
      expect(client.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(
        true,
      ),
    );
    expect(toolAborted).toBe(true);
    releaseUnsubscribe?.();
    await expect(run).resolves.toEqual({ text: "Finished answer." });
  });

  it("projects native side-thread tool notifications into trusted diagnostics", async () => {
    const client = createPendingClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "turn/start") {
        setTimeout(() => {
          client.emit({
            method: "item/started",
            params: {
              ...codexTestTurnIds("side-thread"),
              item: nativeCommandItem("native-tool-1", "inProgress", null),
            },
          });
          client.emit({
            method: "item/completed",
            params: {
              ...codexTestTurnIds("side-thread"),
              item: nativeCommandItem("native-tool-1", "completed", 12),
            },
          });
          const webSearchItem = {
            type: "webSearch",
            id: "native-search-1",
            query: "sensitive side-thread query",
            action: {
              type: "search",
              query: "sensitive side-thread query",
              queries: null,
            },
          };
          client.emit({
            method: "item/started",
            params: { threadId: "side-thread", turnId: "turn-1", item: webSearchItem },
          });
          client.emit({
            method: "item/completed",
            params: { threadId: "side-thread", turnId: "turn-1", item: webSearchItem },
          });
          client.emit(turnCompleted("side-thread", "turn-1", "Native tool answer."));
        }, 0);
        return turnStartResult("turn-1");
      }
      return baseRequest(method, requestParams);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await runCodexAppServerSideQuestion(
        sideParams({
          agentId: "side-agent",
          sessionKey: "agent:side-agent:main",
          opts: { runId: "run-side-native-tool" },
        }),
      );
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

  it("classifies an active side tool as timed out when side completion expires", async () => {
    vi.useFakeTimers();
    const client = createPendingClient();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    toolExecuteMock.mockImplementation(
      (_callId: string, _args: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        }),
    );
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "turn/start") {
        setTimeout(() => {
          void client.handleRequest({
            id: 42,
            method: "item/tool/call",
            params: {
              ...codexTestTurnIds("side-thread"),
              callId: "tool-timeout",
              tool: "wiki_status",
              arguments: {},
            },
          });
        }, 0);
        return turnStartResult("turn-1");
      }
      if (method === "turn/interrupt") {
        queueMicrotask(() =>
          client.emit(turnCompleted("side-thread", "turn-1", "", "interrupted")),
        );
        return {};
      }
      if (method === "thread/backgroundTerminals/list") {
        return { data: [] };
      }
      return baseRequest(method, requestParams);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      const runPromise = runCodexAppServerSideQuestion(
        sideParams({
          agentId: "side-agent",
          sessionKey: "global",
          opts: { runId: "run-side-timeout" },
        }),
      );
      const runResult = runPromise.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(600_000);

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
  });

  it("returns an empty response for side-thread user input requests", async () => {
    const client = createPendingClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    const run = runCodexAppServerSideQuestion(sideParams());
    const userInputResponse = await handleClientRequestWhenReady(client, {
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
    const harness = createClientHarness();
    getSharedCodexAppServerClientMock.mockResolvedValue(harness.client);
    const waitForRequest = async (method: string) =>
      await vi.waitFor(() => {
        const request = harness.writes
          .map((write) => JSON.parse(write) as { id: number; method: string; params: unknown })
          .find((message) => message.method === method);
        expect(request).toBeDefined();
        return request!;
      });
    const controller = new AbortController();
    const run = runCodexAppServerSideQuestion(
      sideParams({ opts: { abortSignal: controller.signal } }),
    );
    const failure = run.catch((error: unknown) => error);
    const fork = await waitForRequest("thread/fork");
    harness.send({ id: fork.id, result: threadResult("side-thread") });
    await waitForRequest("thread/inject_items");
    controller.abort("lost policy ACK");
    const unsubscribe = await waitForRequest("thread/unsubscribe");
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

  it("returns a clear setup error when there is no Codex parent thread", async () => {
    readCodexAppServerBindingMock.mockReturnValue(undefined);

    await expect(runCodexAppServerSideQuestion(sideParams())).rejects.toThrow(
      "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
    );
    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it("returns the same setup error when the persisted parent binding is stale", async () => {
    const client = createFakeClient({ completeTurn: false });
    client.request.mockImplementation(async (method: string) => {
      if (method === "thread/fork") {
        throw new Error("thread/fork failed: no rollout found for thread id parent-thread");
      }
      return {};
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(runCodexAppServerSideQuestion(sideParams())).rejects.toThrow(
      "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
    );
  });
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
    const turnStarted = createDeferred<void>();
    const client = createFakeClient({ completeTurn: false, onTurnStart: turnStarted.resolve });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    const parent = { threadId: "parent-thread", cwd: workspaceDir, model: "gpt-5.5" };
    const run = runCodexAppServerSideQuestionImpl(
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
      { bindingStore: { ...createCodexTestBindingStore(), read: () => parent } },
    );
    try {
      await Promise.race([
        turnStarted.promise,
        run.then(() => {
          throw new Error("Side question ended before accepting its turn");
        }),
      ]);
      const execResponse = await client.handleRequest({
        id: "side-gateway-exec",
        method: "item/tool/call",
        params: {
          ...codexTestTurnIds("side-thread"),
          callId: "side-gateway-exec",
          tool: "gateway_exec",
          arguments: { command: "printf codex-side-shell", workdir: workspaceDir },
        },
      });
      expect(execResponse).toMatchObject({ success: true });
      expect(JSON.stringify(execResponse)).toContain("codex-side-shell");
      const processResponse = await client.handleRequest({
        id: "side-gateway-process",
        method: "item/tool/call",
        params: {
          ...codexTestTurnIds("side-thread"),
          callId: "side-gateway-process",
          tool: "gateway_process",
          arguments: { action: "list" },
        },
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

  it.each([
    { label: "before its request is written", written: false, interruptFails: false },
    {
      label: "when its native thread cannot unsubscribe",
      written: true,
      interruptFails: false,
      unsubscribeFails: true,
    },
    {
      label: "when its startup interrupt fails with a retained peer",
      written: true,
      interruptFails: true,
      peerRetained: true,
    },
    {
      label: "when its startup interrupt and client retirement fail",
      written: true,
      interruptFails: true,
      retirementFails: true,
    },
  ])(
    "scopes side-turn abort cleanup $label",
    async ({ written, interruptFails, retirementFails, unsubscribeFails, peerRetained }) => {
      const controller = new AbortController();
      const harness = createClientHarness();
      const requests = vi.spyOn(harness.client, "request");
      if (peerRetained) {
        retireSharedCodexAppServerClientIfCurrentMock.mockReturnValueOnce({
          activeLeases: 2,
          closed: false,
        });
      }
      if (retirementFails) {
        vi.spyOn(harness.client, "closeAndWait").mockRejectedValueOnce(
          new Error("side client retirement failed"),
        );
      }
      getSharedCodexAppServerClientMock.mockResolvedValue(harness.client);
      const waitForRequest = async (method: string) =>
        await vi.waitFor(
          () => {
            const request = harness.writes
              .map((write) => JSON.parse(write) as { id: number; method: string; params: unknown })
              .find((message) => message.method === method);
            if (!request) {
              throw new Error(`Codex side harness did not write ${method}`);
            }
            return request;
          },
          { interval: 1, timeout: 5_000 },
        );
      const run = runCodexAppServerSideQuestion(
        sideParams({ opts: { abortSignal: controller.signal } }),
      );
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
          if (turnStart?.type !== "return") {
            throw new Error("Expected the native turn/start request promise");
          }
          const primaryError = await turnStart.value.catch((reason: unknown) => reason);
          expect(primaryError).toMatchObject({
            message: "turn/start aborted: side-start-cancelled",
            cause: "side-start-cancelled",
            reason: "aborted",
            mayHaveWritten: true,
          });
          if (interruptFails) {
            expect(error).toBeInstanceOf(AggregateError);
            if (!(error instanceof AggregateError)) {
              throw new Error("Expected cancellation and native cleanup failures", {
                cause: error,
              });
            }
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
        expect(harness.stdinDestroyed).toBe(
          (interruptFails && !peerRetained) || unsubscribeFails === true,
        );
        if (peerRetained) {
          expect(retireSharedCodexAppServerClientIfCurrentMock).toHaveBeenCalledExactlyOnceWith(
            harness.client,
          );
        }
      } finally {
        controller.abort();
        harness.client.close();
        await failure;
      }
    },
  );

  it.each([
    { terminationFails: false, projectorFails: false },
    { terminationFails: true, projectorFails: true },
  ])(
    "settles side background-terminal cleanup before cancellation returns (terminal failure: $terminationFails, projector failure: $projectorFails)",
    async ({ terminationFails, projectorFails }) => {
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
      if (projectorFails) {
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
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      let settled = false;
      const run = runCodexAppServerSideQuestion(
        sideParams({ opts: { abortSignal: controller.signal } }),
      )
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
        if (wait?.type !== "return") {
          throw new Error("Expected the native side-turn completion promise");
        }
        const primaryError = await wait.value.catch((reason: unknown) => reason);
        expect(primaryError).toMatchObject({ message: "Codex /btw was aborted." });
        if (terminationFails) {
          const cleanup = terminalCleanup.mock.results[0];
          if (cleanup?.type !== "return") {
            throw new Error("Expected the native terminal cleanup promise");
          }
          const cleanupError = await cleanup.value.catch((reason: unknown) => reason);
          expect(cleanupError).toMatchObject({
            message: expect.stringContaining("background-terminal cleanup failed"),
          });
          expect(error).toBeInstanceOf(AggregateError);
          if (!(error instanceof AggregateError)) {
            throw new Error("Expected cancellation and terminal cleanup failures", {
              cause: error,
            });
          }
          expect(error.cause).toBe(primaryError);
          expect(error.errors).toHaveLength(projectorFails ? 3 : 2);
          expect(error.errors[0]).toBe(primaryError);
          expect(error.errors[1]).toBe(cleanupError);
          expect(error.message).toContain("Codex /btw was aborted.");
          expect(error.message).toContain("background-terminal cleanup failed");
          if (projectorFails) {
            expect(error.errors[2]).toBe(projectorError);
            expect(error.message).toContain(projectorError.message);
          }
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
  it("delivers a side thread's question prompt through its provider channel", async () => {
    const onToolResult = vi.fn();
    type ToolOptions = NonNullable<
      Parameters<
        (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"]
      >[0]
    >;
    let capturedQuestionPrompt: ToolOptions["questionPrompt"];
    createOpenClawCodingToolsMock.mockImplementation((options: ToolOptions) => {
      capturedQuestionPrompt = options.questionPrompt;
      return [
        {
          name: "ask_user",
          description: "Ask the person a question",
          parameters: { type: "object", properties: {}, additionalProperties: true },
          execute: toolExecuteMock,
        },
      ];
    });

    await runSideQuestionWithManagedWebSearchCall(
      sideParams({
        messageProvider: "telegram",
        opts: { onToolResult },
      }),
      { preserveToolFactory: true, toolName: "ask_user", toolArguments: { header: "Choice" } },
    );

    expect(toolExecuteMock).toHaveBeenCalledTimes(1);
    expect(capturedQuestionPrompt).toBeDefined();
    expect(capturedQuestionPrompt?.messageChannel).toBe("telegram");
    await capturedQuestionPrompt?.send({ text: "Question for you:" });
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith({ text: "Question for you:" });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
