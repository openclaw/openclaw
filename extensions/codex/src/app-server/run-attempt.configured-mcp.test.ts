import { getEventListeners } from "node:events";
import path from "node:path";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  createPluginMetadataSnapshotFixture,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";
import {
  appendOrdinaryDynamicToolFixtures,
  materializeStaticMcpFixture,
  resetConfiguredMcpFixtureState,
  type StaticToolExecuteMock,
} from "./run-attempt.configured-mcp.test-support.js";

const mcpMocks = vi.hoisted(() => ({
  authorityResolvers: [] as Array<
    (options?: { signal?: AbortSignal }) => Promise<{
      tools: readonly (string | { name: string; pluginId?: string })[];
      provenance: { version: 1; source: "final-executable-surface" };
    }>
  >,
  captureCalls: [] as Array<{
    sourceNames: string[];
    storedNames: string[];
    provenance?: unknown;
  }>,
  captureRefs: [] as Array<{
    value?: { version: 1; source: "final-executable-surface" };
  }>,
  dispose: vi.fn(async () => undefined),
  captureFacade: vi.fn(),
  staticFacade: vi.fn(),
  threadConfigFacade: vi.fn(),
  requesterCalls: 0,
  materializationOrder: [] as string[],
  requesterCollisionTool: false,
  requesterParams: [] as Array<Record<string, unknown>>,
  requesterScopedServerNames: [] as string[],
  requesterToolNames: [] as string[],
  requesterDiagnosticNotice: undefined as string | undefined,
  requesterDispose: vi.fn(async () => undefined),
  ordinaryToolNames: [] as string[],
  staticDiagnosticNotice: undefined as string | undefined,
  staticFailure: undefined as Error | undefined,
  staticFailureGate: undefined as Promise<void> | undefined,
  staticCalls: [] as Array<Record<string, unknown>>,
  staticBaseToolName: "fake__show",
  staticHonorToolsAllow: false,
  staticProducedToolNames: [] as string[],
  staticToolExecutes: [] as StaticToolExecuteMock[],
  threadConfigCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("./dynamic-tool-build.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dynamic-tool-build.js")>();
  return {
    ...actual,
    buildDynamicTools: async (...args: Parameters<typeof actual.buildDynamicTools>) => {
      const tools = await actual.buildDynamicTools(...args);
      return appendOrdinaryDynamicToolFixtures(tools, mcpMocks.ordinaryToolNames);
    },
  };
});

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    materializeRequesterScopedMcpToolsForHarnessRun: async (
      ...args: Parameters<typeof actual.materializeRequesterScopedMcpToolsForHarnessRun>
    ) => {
      mcpMocks.requesterCalls += 1;
      mcpMocks.materializationOrder.push("resolver");
      mcpMocks.requesterParams.push(args[0] as Record<string, unknown>);
      if (mcpMocks.requesterCollisionTool) {
        const reserved = new Set(args[0].reservedToolNames);
        mcpMocks.requesterToolNames = [reserved.has("fake__show") ? "fake__show_2" : "fake__show"];
      }
      if (mcpMocks.requesterToolNames.length === 0 && !mcpMocks.requesterDiagnosticNotice) {
        return undefined;
      }
      const tools = mcpMocks.requesterToolNames.map((name) => ({
        name,
        description: `Requester-scoped fixture ${name}`,
        parameters: { type: "object", properties: {} },
        execute: vi.fn(async () => ({
          content: [{ type: "text" as const, text: "requester-result" }],
          details: { status: "ok" },
        })),
      }));
      return {
        tools,
        advertisedTools: tools,
        allocatedToolNames: tools.map((tool) => tool.name),
        mcpNameAllocations: tools.map((tool) => ({
          name: tool.name,
          baseName: tool.name,
          identity: JSON.stringify(["requester", "tool", tool.name]),
        })),
        ...(mcpMocks.requesterDiagnosticNotice
          ? { diagnosticNotice: mcpMocks.requesterDiagnosticNotice }
          : {}),
        dispose: mcpMocks.requesterDispose,
      };
    },
    loadCodexBundleMcpThreadConfig: async (
      ...args: Parameters<typeof actual.loadCodexBundleMcpThreadConfig>
    ) => {
      const params = args[0] as Record<string, unknown>;
      mcpMocks.threadConfigCalls.push(params);
      const override = mcpMocks.threadConfigFacade(params);
      if (override) {
        return override;
      }
      const cfg = params.cfg as
        | { mcp?: { servers?: Record<string, Record<string, unknown>> } }
        | undefined;
      const configuredServers = cfg?.mcp?.servers ?? {};
      const staticServerNames = Object.keys(configuredServers).toSorted();
      return {
        configPatch: staticServerNames.length > 0 ? { mcp_servers: configuredServers } : undefined,
        diagnostics: [],
        evaluated: true,
        fingerprint: staticServerNames.length > 0 ? "configured-mcp-test-fixture" : undefined,
        staticServerNames,
        requesterScopedServerNames: [...mcpMocks.requesterScopedServerNames],
        userStaticServerNames: staticServerNames,
      };
    },
  };
});

vi.mock("openclaw/plugin-sdk/codex-mcp-projection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/codex-mcp-projection")>();
  return {
    ...actual,
    runWithCronCreatorAuthorityCapabilityResolver: (
      params: Parameters<typeof actual.runWithCronCreatorAuthorityCapabilityResolver>[0],
    ) => {
      if (
        params.capability?.active !== true ||
        !params.runId ||
        params.capability.runId !== params.runId
      ) {
        return actual.runWithCronCreatorAuthorityCapabilityResolver(params as never);
      }
      mcpMocks.authorityResolvers.push(params.resolve);
      return actual.runWithCronCreatorAuthorityCapabilityResolver(params as never);
    },
    materializeStaticMcpToolsForHarnessRun: async (params: Record<string, unknown>) => {
      return materializeStaticMcpFixture(params, mcpMocks);
    },
    captureFinalCodexCronCreatorToolAllowlist: async (
      ...args: Parameters<typeof actual.captureFinalCodexCronCreatorToolAllowlist>
    ) => {
      const [target, captureRef, tools] = args;
      mcpMocks.captureRefs.push(captureRef);
      mcpMocks.captureFacade(target, captureRef, tools);
      target.length = 0;
      for (const tool of tools) {
        if (
          !target.some((entry) => (typeof entry === "string" ? entry : entry.name) === tool.name)
        ) {
          target.push({ name: tool.name });
        }
      }
      captureRef.value = { version: 1, source: "final-executable-surface" };
      mcpMocks.captureCalls.push({
        sourceNames: tools.map((tool) => tool.name).toSorted(),
        storedNames: target
          .map((entry) => (typeof entry === "string" ? entry : entry.name))
          .toSorted(),
        provenance: captureRef.value,
      });
    },
  };
});

import * as attemptContext from "./attempt-context.js";
import { createCronAuthorityCapabilityFixture } from "./codex-app-server.test-fixtures.js";
import * as dynamicTools from "./dynamic-tools.js";
import {
  assistantMessage,
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

beforeEach(() => {
  resetConfiguredMcpFixtureState(mcpMocks);
  mcpMocks.requesterCollisionTool = false;
});

function configureFakeMcp(params: ReturnType<typeof createParams>) {
  setCodexTestModelSupportsTools(params, true);
  params.cleanupBundleMcpOnRunEnd = true;
  params.runtimePlan = createCodexRuntimePlanFixture();
  const metadataSnapshot = createPluginMetadataSnapshotFixture();
  params.preparedModelRuntime = { metadataSnapshot } as never;
  params.config = {
    ...params.config,
    mcp: {
      servers: {
        fake: {
          command: process.execPath,
          args: [path.resolve("scripts/e2e/mcp-app-conformance-server.mjs")],
          codex: { defaultToolsApprovalMode: "prompt" },
        },
      },
    },
  };
  return metadataSnapshot;
}

function admitLocalOperatorCronAuthority(params: ReturnType<typeof createParams>): void {
  params.cronCreatorAuthorityCapability = createCronAuthorityCapabilityFixture(params.runId);
}

describe("runCodexAppServerAttempt configured MCP ownership", () => {
  it.each(
    ["cancellation", "authority closure"].flatMap((reason) =>
      [false, true].map((rejectCleanup) => ({ reason, rejectCleanup })),
    ),
  )(
    "disposes acquired MCP handles on history $reason (cleanup rejects=$rejectCleanup)",
    async ({ reason, rejectCleanup }) => {
      const sessionFile = path.join(tempDir, "session-context-read-cancel.jsonl");
      const params = createParams(sessionFile, path.join(tempDir, "workspace-context-read-cancel"));
      configureFakeMcp(params);
      params.toolsAllow = ["cron", "fake__show"];
      mcpMocks.requesterCollisionTool = true;
      if (rejectCleanup) {
        mcpMocks.requesterDispose.mockRejectedValueOnce(new Error("synthetic MCP cleanup failure"));
      }
      const controller = new AbortController();
      params.abortSignal = controller.signal;
      const upstreamListeners = getEventListeners(controller.signal, "abort").length;
      let active = true;
      const hostCapabilities = params.hostCapabilities;
      params.hostCapabilities = Object.freeze({
        ...hostCapabilities,
        assertActive() {
          if (!active) {
            throw new Error("authority closed during model-history preparation");
          }
          hostCapabilities.assertActive();
        },
      });
      const readEntered = createDeferred<void>();
      const readGate = createDeferred<void>();
      const read = vi
        .spyOn(attemptContext, "readMirroredSessionHistoryMessages")
        .mockImplementationOnce(async () => {
          readEntered.resolve();
          await readGate.promise;
          return [];
        });
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      const rejected = expect(run).rejects.toThrow("during model-history preparation");
      try {
        await readEntered.promise;
        expect(mcpMocks.staticCalls).toHaveLength(1);
        expect(mcpMocks.requesterCalls).toBe(1);
        if (reason === "cancellation") {
          controller.abort(new Error("cancelled during model-history preparation"));
        } else {
          active = false;
        }
        readGate.resolve();
        await rejected;
        expect({
          configuredDisposals: mcpMocks.dispose.mock.calls.length,
          scopedDisposals: mcpMocks.requesterDispose.mock.calls.length,
          nativeThreadStarted: harness.requests.some(
            (request) => request.method === "thread/start",
          ),
          upstreamListeners: getEventListeners(controller.signal, "abort").length,
        }).toEqual({
          configuredDisposals: 1,
          scopedDisposals: 1,
          nativeThreadStarted: false,
          upstreamListeners,
        });
      } finally {
        readGate.resolve();
        await run.catch(() => undefined);
        read.mockRestore();
      }
    },
  );

  it("preserves the setup failure and disposes both MCP handles when the first disposal rejects", async () => {
    const sessionFile = path.join(tempDir, "session-mcp-bridge-failure.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-mcp-bridge-failure"));
    configureFakeMcp(params);
    params.toolsAllow = ["cron", "fake__show"];
    mcpMocks.requesterCollisionTool = true;
    const failure = new Error("synthetic dynamic bridge failure");
    const bridge = vi
      .spyOn(dynamicTools, "createCodexDynamicToolBridge")
      .mockImplementationOnce(() => {
        throw failure;
      });
    mcpMocks.requesterDispose.mockRejectedValueOnce(new Error("synthetic MCP cleanup failure"));
    const harness = createStartedThreadHarness();
    try {
      const result = await runCodexAppServerAttempt(params).catch((error: unknown) => error);
      expect({
        originalFailure: result === failure,
        configuredDisposals: mcpMocks.dispose.mock.calls.length,
        scopedDisposals: mcpMocks.requesterDispose.mock.calls.length,
        nativeThreadStarted: harness.requests.some((request) => request.method === "thread/start"),
      }).toEqual({
        originalFailure: true,
        configuredDisposals: 1,
        scopedDisposals: 1,
        nativeThreadStarted: false,
      });
    } finally {
      bridge.mockRestore();
    }
  });

  it("releases the upstream abort listener when tool preparation fails before ownership transfer", async () => {
    const sessionFile = path.join(tempDir, "session-tool-preparation-failure.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-tool-preparation-failure"),
    );
    configureFakeMcp(params);
    params.toolsAllow = ["cron", "fake__show"];
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    const upstreamListeners = getEventListeners(controller.signal, "abort").length;
    const failure = new Error("synthetic tool materialization failure");
    mcpMocks.staticFailure = failure;
    const harness = createStartedThreadHarness();

    await expect(runCodexAppServerAttempt(params)).rejects.toBe(failure);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(upstreamListeners);
    expect(mcpMocks.dispose).not.toHaveBeenCalled();
    expect(mcpMocks.requesterDispose).not.toHaveBeenCalled();
    expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("disposes both acquired MCP handles once when native startup fails", async () => {
    const sessionFile = path.join(tempDir, "session-native-startup-failure.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-native-startup-failure"),
    );
    configureFakeMcp(params);
    params.toolsAllow = ["cron", "fake__show"];
    mcpMocks.requesterCollisionTool = true;
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    const upstreamListeners = getEventListeners(controller.signal, "abort").length;
    const failure = new Error("synthetic native startup failure");
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        throw failure;
      }
      return undefined;
    });

    await expect(runCodexAppServerAttempt(params)).rejects.toBe(failure);

    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(upstreamListeners);
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("does not replace bundle discovery with partial prepared plugin metadata", async () => {
    const sessionFile = path.join(tempDir, "session-partial-manifest-registry.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-partial-registry"));
    const metadataSnapshot = configureFakeMcp(params);
    metadataSnapshot.pluginIds = ["codex"];

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(mcpMocks.threadConfigCalls[0]?.manifestRegistry).toBeUndefined();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("projects scheduled static MCP dynamically under the exact stored cap", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-static-mcp.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-scheduled-static-mcp"));
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["*"];
    params.scheduledToolPolicy = { version: 1, mode: "trusted" };

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { config?: Record<string, unknown>; dynamicTools?: unknown } | undefined;
    expect(mcpMocks.requesterCalls).toBe(0);
    expect(mcpMocks.threadConfigCalls[0]?.manifestRegistry).toBe(
      params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
    );
    expect(mcpMocks.threadConfigFacade).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: params.workspaceDir,
        cfg: params.config,
        toolsAllow: ["*"],
        manifestRegistry: params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
      }),
    );
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(threadStart?.config).not.toHaveProperty("mcp_servers");
    expect(JSON.stringify(threadStart?.config ?? {})).not.toContain("fake-mcp");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("fake__show");
    expect(mcpMocks.staticCalls[0]).not.toHaveProperty("requesterSenderId");
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      toolsAllow: ["*"],
      manifestRegistry: params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
      autoApproveCodexAppServerApprovals: true,
    });
    expect(mcpMocks.staticFacade).toHaveBeenCalledWith(mcpMocks.staticCalls[0]);

    const toolResult = await harness.handleServerRequest({
      id: "request-fake-ping",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-fake-ping",
        namespace: null,
        tool: "fake__show",
        arguments: {},
      },
    });
    expect(toolResult).toMatchObject({ success: true });
    expect(JSON.stringify(toolResult)).toContain("initial-result");
    expect(mcpMocks.staticToolExecutes[0]).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]).toMatchObject({
      sourceNames: expect.arrayContaining(["fake__show"]),
      storedNames: expect.arrayContaining(["fake__show"]),
      provenance: { version: 1, source: "final-executable-surface" },
    });
    expect(mcpMocks.captureCalls[0]!.storedNames).toEqual(mcpMocks.captureCalls[0]!.sourceNames);
    expect(mcpMocks.captureFacade).toHaveBeenCalledOnce();
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).toMatchObject({ configuredMcpOwnershipVersion: 1 });
    expect(binding).not.toHaveProperty("mcpServersFingerprint");
    expect(binding).not.toHaveProperty("userMcpServersFingerprint");
  });

  it("projects requesterless resolvers for account-owned scheduled runs without replaying requester identity", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-background-resolver.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-background-resolver"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["fake__show", "resolver__read"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
      mcpToolBindings: [
        {
          name: "fake__show",
          serverName: "static",
          operation: "tool",
          toolName: "fake__show",
        },
        {
          name: "resolver__read",
          serverName: "requester",
          operation: "tool",
          toolName: "resolver__read",
        },
      ],
    };
    params.senderId = "owner:must-not-be-replayed";
    params.agentAccountId = "default";
    params.messageChannel = "arxi";
    params.chatType = "direct";
    params.chatId = "telegram-chat:42";
    mcpMocks.requesterScopedServerNames.push("resolver");
    mcpMocks.requesterToolNames.push("resolver__read");

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { dynamicTools?: unknown } | undefined;
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("fake__show");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("resolver__read");
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.requesterCalls).toBe(1);
    expect(mcpMocks.requesterParams[0]).toMatchObject({
      sessionKey: params.sessionKey,
      agentId: "main",
      toolsAllow: ["fake__show", "resolver__read"],
      reservedToolNames: expect.not.arrayContaining(["fake__show"]),
      scheduledCodexApproval: { autoApprove: true },
    });
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      reservedToolNames: expect.arrayContaining(["resolver__read"]),
    });
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("requesterSenderId");
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("agentAccountId");
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("messageChannel");
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("chatType");
    expect(mcpMocks.requesterParams[0]).not.toHaveProperty("conversationId");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
  });

  it.each([["*"], ["resolver__read"]])(
    "projects requesterless resolvers for trusted scheduled runs under cap %j",
    async (grant) => {
      const sessionFile = path.join(tempDir, "session-trusted-background-resolver.jsonl");
      const params = createParams(sessionFile, path.join(tempDir, "workspace-trusted-background"));
      configureFakeMcp(params);
      params.trigger = "cron";
      params.toolsAllow = [grant];
      params.scheduledToolPolicy = { version: 1, mode: "trusted" };
      params.senderId = "owner:must-not-be-replayed";
      params.agentAccountId = "default";
      params.messageChannel = "arxi";
      params.chatType = "direct";
      params.chatId = "telegram-chat:42";
      mcpMocks.requesterScopedServerNames.push("resolver");
      mcpMocks.requesterToolNames.push("resolver__read");

      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
        },
      });
      await harness.waitForMethod("turn/start");
      const threadStart = harness.requests.find((request) => request.method === "thread/start")
        ?.params as { dynamicTools?: unknown } | undefined;
      expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("resolver__read");
      expect(mcpMocks.requesterParams[0]).toMatchObject({
        agentId: "main",
        sessionKey: params.sessionKey,
        toolsAllow: [grant],
        scheduledCodexApproval: { autoApprove: true },
      });
      for (const field of [
        "requesterSenderId",
        "agentAccountId",
        "messageChannel",
        "chatType",
        "conversationId",
      ]) {
        expect(mcpMocks.requesterParams[0]).not.toHaveProperty(field);
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).resolves.toBeDefined();
      expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
    },
  );

  it("rejects a configured tool that takes a disappeared resolver's persisted name", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-background-collision.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-background-collision"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["a__b__c", "resolver__other"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
      mcpToolBindings: [
        {
          name: "a__b__c",
          serverName: "requester",
          operation: "tool",
          toolName: "a__b__c",
        },
        {
          name: "resolver__other",
          serverName: "requester",
          operation: "tool",
          toolName: "resolver__other",
        },
      ],
    };
    mcpMocks.requesterScopedServerNames.push("resolver");
    mcpMocks.requesterToolNames.push("resolver__other");
    mcpMocks.staticBaseToolName = "a__b__c";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    expect(mcpMocks.materializationOrder.slice(0, 2)).toEqual(["resolver", "static"]);
    expect(mcpMocks.staticProducedToolNames).toEqual(["a__b__c"]);
    expect(mcpMocks.requesterParams[0]).toMatchObject({
      reservedToolNames: expect.not.arrayContaining(["resolver__other"]),
    });
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      reservedToolNames: expect.arrayContaining(["resolver__other"]),
    });
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { dynamicTools?: unknown } | undefined;
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).not.toContain("a__b__c");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("resolver__other");
    expect(JSON.stringify(threadStart ?? {})).toContain(
      "persisted tool identity no longer matches",
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("does not transfer a persisted MCP name to an ordinary dynamic tool", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-mcp-dynamic-takeover.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-mcp-dynamic-takeover"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["automations"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
      mcpToolBindings: [
        {
          name: "automations",
          serverName: "static",
          operation: "tool",
          toolName: "automations",
        },
      ],
    };
    mcpMocks.staticBaseToolName = "automations";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    expect(mcpMocks.staticProducedToolNames).toEqual(["automations-2"]);
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { dynamicTools?: Array<{ name?: string }> } | undefined;
    const dynamicToolNames = threadStart?.dynamicTools?.map((tool) => tool.name) ?? [];
    expect(dynamicToolNames).not.toContain("automations");
    expect(dynamicToolNames).not.toContain("automations-2");
    expect(JSON.stringify(threadStart ?? {})).toContain(
      "persisted tool identity no longer matches",
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("quarantines a legacy MCP-shaped name when an ordinary dynamic tool takes it", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-legacy-mcp-takeover.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-legacy-mcp-takeover"),
    );
    configureFakeMcp(params);
    params.config = { ...params.config, mcp: { servers: {} } };
    params.trigger = "cron";
    params.toolsAllow = ["legacy__lookup"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
    };
    mcpMocks.ordinaryToolNames.push("legacy__lookup");

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { dynamicTools?: Array<{ name?: string }> } | undefined;
    const dynamicToolNames = threadStart?.dynamicTools?.map((tool) => tool.name) ?? [];
    expect(dynamicToolNames).not.toContain("legacy__lookup");
    expect(mcpMocks.staticCalls).toEqual([]);
    expect(JSON.stringify(threadStart ?? {})).toContain(
      "persisted tool identity no longer matches",
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("keeps background resolver failures visible to the scheduled agent", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-background-resolver-failure.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-background-resolver-failure"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = ["fake__show", "resolver__read"];
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
      mcpToolBindings: [
        {
          name: "fake__show",
          serverName: "static",
          operation: "tool",
          toolName: "fake__show",
        },
        {
          name: "resolver__read",
          serverName: "requester",
          operation: "tool",
          toolName: "resolver__read",
        },
      ],
    };
    mcpMocks.requesterScopedServerNames.push("resolver");
    mcpMocks.requesterDiagnosticNotice =
      "Configured MCP is incomplete for this scheduled run: resolver: background connection unavailable. " +
      "Do not claim MCP-backed work succeeded; report this blocker to the operator.";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "workspace-write" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(JSON.stringify(threadStart?.params)).toContain("background connection unavailable");
    expect(mcpMocks.requesterParams[0]).toMatchObject({
      scheduledCodexApproval: { autoApprove: false },
    });
    expect(mcpMocks.staticCalls).toEqual([]);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
  });

  it("keeps normalized wildcard account runs inside the scheduled boundary", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-background-wildcard.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-background-wildcard"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = undefined;
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
    };
    params.senderId = "owner:must-not-be-replayed";
    params.agentAccountId = "default";
    params.messageChannel = "arxi";
    params.chatType = "direct";
    params.chatId = "telegram-chat:42";
    mcpMocks.requesterScopedServerNames.push("resolver");
    mcpMocks.requesterToolNames.push("resolver__read");

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "workspace-write" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(mcpMocks.requesterCalls).toBe(0);
    expect(JSON.stringify(threadStart?.params)).not.toContain("resolver__read");
    expect(JSON.stringify(threadStart?.params)).toContain("no explicit finite toolsAllow");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(mcpMocks.requesterDispose).not.toHaveBeenCalled();
    expect(mcpMocks.staticCalls).toEqual([]);
  });

  it("does not invent a missing-cap resolver blocker when an account run has only static MCP", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-static-wildcard.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-scheduled-static-wildcard"),
    );
    configureFakeMcp(params);
    params.trigger = "cron";
    params.toolsAllow = undefined;
    params.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:external:owner-turn",
      ownerAccountId: "default",
    };

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "workspace-write" },
      },
    });
    await harness.waitForMethod("turn/start");

    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    expect(mcpMocks.requesterCalls).toBe(0);
    expect(JSON.stringify(threadStart?.params)).not.toContain("no explicit finite toolsAllow");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("preserves bounded canonical continuity when scheduled MCP replaces ordinary ownership", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-mcp-ownership-continuity.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-scheduled-mcp-ownership-continuity");
    const cutoff = Date.now();
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-ordinary",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      mcpServersFingerprint: "configured-mcp-test-fixture",
      historyCoveredThrough: new Date(cutoff).toISOString(),
    });
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    sessionManager.appendMessage(userMessage("ordinary-thread covered context", cutoff - 1_000));
    for (let index = 0; index < 10; index += 1) {
      sessionManager.appendMessage(
        assistantMessage(
          `scheduled ownership continuity block ${index}: ${"x".repeat(128_000)}`,
          cutoff + 2_000 + index,
        ),
      );
    }
    sessionManager.appendMessage(userMessage("new scheduled ownership question", cutoff + 20_000));
    sessionManager.appendMessage(
      assistantMessage("recent scheduled ownership answer", cutoff + 21_000),
    );

    const params = createParams(sessionFile, workspaceDir);
    configureFakeMcp(params);
    params.prompt = "continue after the scheduled ownership transition";
    params.trigger = "cron";
    params.toolsAllow = ["*"];
    params.scheduledToolPolicy = { version: 1, mode: "trusted" };
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-ordinary",
        });
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(harness.requests.map((request) => request.method)).toContain("thread/start");
    expect(harness.requests.map((request) => request.method)).not.toContain("thread/resume");
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(inputText.length).toBeLessThanOrEqual(1 << 20);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("new scheduled ownership question");
    expect(inputText).toContain("recent scheduled ownership answer");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("continue after the scheduled ownership transition");
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
      configuredMcpOwnershipVersion: 1,
    });
  });

  it.each([
    { mode: undefined, source: "operator", delegate: false },
    { mode: "approve", source: "operator", delegate: false },
    { mode: "auto", source: "operator", delegate: true },
    { mode: "prompt", source: "operator", delegate: true },
    { mode: "prompt", source: "bundle", delegate: true },
    { mode: "approve", source: "operator-over-bundle", delegate: false },
  ] as const)(
    "honors $source MCP approval mode $mode at thread and turn startup",
    async (testCase) => {
      const sessionFile = path.join(tempDir, "session-native-mcp-auth-failure.jsonl");
      const params = createParams(
        sessionFile,
        path.join(tempDir, "workspace-native-mcp-auth-failure"),
      );
      configureFakeMcp(params);
      params.config!.mcp!.servers!.fake!.codex = { defaultToolsApprovalMode: testCase.mode };
      if (testCase.source === "bundle") {
        params.config!.mcp = {};
        mcpMocks.threadConfigFacade.mockReturnValueOnce({
          configPatch: {
            mcp_servers: {
              bundled: {
                url: "https://mcp.example.test",
                default_tools_approval_mode: testCase.mode,
              },
            },
          },
          diagnostics: [],
          evaluated: true,
          staticServerNames: ["bundled", "unannotated"],
          requesterScopedServerNames: [],
          userStaticServerNames: ["unannotated"],
        });
      } else if (testCase.source === "operator-over-bundle") {
        mcpMocks.threadConfigFacade.mockReturnValueOnce({
          configPatch: {
            mcp_servers: {
              fake: { url: "https://mcp.example.test", default_tools_approval_mode: "prompt" },
            },
          },
          diagnostics: [],
          evaluated: true,
          staticServerNames: ["fake", "unannotated"],
          requesterScopedServerNames: [],
          userStaticServerNames: ["fake", "unannotated"],
        });
      }
      params.config!.mcp!.servers = {
        ...params.config!.mcp!.servers,
        unannotated: { url: "https://unannotated.example.test/mcp" },
      };
      const requestApproval = vi.fn(async (_request: { description?: string }) => ({
        id: "plugin:mcp-fixture",
      }));
      const waitForApproval = vi.fn(async () => ({
        decision: "deny" as const,
        terminalReason: "user" as const,
      }));
      params.hostCapabilities = Object.freeze({
        ...params.hostCapabilities,
        requestApproval,
        waitForApproval,
      });

      const harness = createStartedThreadHarness(async (method) => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "fake",
                serverInfo: null,
                authStatus: "notLoggedIn",
                tools: {},
              },
            ],
            nextCursor: null,
          };
        }
        return undefined;
      });
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
        },
      });
      await harness.waitForMethod("turn/start");
      const responses = [];
      for (const serverName of ["unannotated", testCase.source === "bundle" ? "bundled" : "fake"]) {
        responses.push(
          await harness.handleServerRequest({
            id: `approval-${serverName}`,
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              serverName,
              mode: "form",
              _meta: { codex_approval_kind: "mcp_tool_call" },
              requestedSchema: { type: "object", properties: {} },
            },
          }),
        );
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).resolves.toBeDefined();

      expect(responses).toEqual([
        { action: "accept", content: null, _meta: null },
        { action: testCase.delegate ? "decline" : "accept", content: null, _meta: null },
      ]);
      expect(requestApproval).toHaveBeenCalledTimes(testCase.delegate ? 1 : 0);
      expect(waitForApproval).toHaveBeenCalledTimes(testCase.delegate ? 1 : 0);
      // Codex drops decline meta, so the remedy must reach the operator via the card.
      if (testCase.delegate) {
        expect(requestApproval.mock.calls[0]?.[0]?.description).toContain(
          `openclaw mcp configure ${testCase.source === "bundle" ? "bundled" : "fake"} --approval approve`,
        );
      }
      const expectedApprovalPolicy = testCase.delegate
        ? {
            granular: {
              mcp_elicitations: true,
              rules: false,
              sandbox_approval: false,
              request_permissions: false,
              skill_approval: false,
            },
          }
        : "never";
      for (const method of ["thread/start", "turn/start"]) {
        expect(harness.requests.find((request) => request.method === method)?.params).toMatchObject(
          {
            approvalPolicy: expectedApprovalPolicy,
          },
        );
      }
      expect(harness.requests.map((request) => request.method)).not.toContain(
        "mcpServerStatus/list",
      );
      expect(mcpMocks.staticCalls).toHaveLength(0);
      expect(mcpMocks.requesterParams[0]?.manifestRegistry).toBe(
        params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
      );
      expect(mcpMocks.captureCalls).toHaveLength(1);
      expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
    },
  );

  it("keeps ordinary configured MCP native without probing or stamping its inventory", async () => {
    const sessionFile = path.join(tempDir, "session-native-mcp-auth-failure.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-native-mcp-auth-failure"),
    );
    configureFakeMcp(params);
    params.agentId = "main";
    params.senderId = "owner:own_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    params.agentAccountId = "default";
    params.messageChannel = "arxi";
    params.chatType = "direct";
    params.chatId = "telegram-chat:42";
    params.lifecycleGeneration = "63";
    params.diagnosticTrace = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      traceFlags: "01",
    };

    const harness = createStartedThreadHarness(async (method) => {
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "fake",
              serverInfo: null,
              authStatus: "notLoggedIn",
              tools: {},
            },
          ],
          nextCursor: null,
        };
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();

    expect(harness.requests.map((request) => request.method)).not.toContain("mcpServerStatus/list");
    expect(mcpMocks.staticCalls).toHaveLength(0);
    expect(mcpMocks.requesterParams[0]?.manifestRegistry).toBe(
      params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
    );
    expect(mcpMocks.requesterParams[0]).toMatchObject({
      sessionKey: params.sessionKey,
      agentId: "main",
      requesterSenderId: "owner:own_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agentAccountId: "default",
      messageChannel: "arxi",
      chatType: "direct",
      conversationId: "telegram-chat:42",
      runtimeGeneration: "63",
      traceId: "1234567890abcdef1234567890abcdef",
    });
    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
  });

  it("keeps configured and requester MCP unique when the native surface is unavailable", async () => {
    const sessionFile = path.join(tempDir, "session-native-mcp-restricted.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-native-mcp-restricted"));
    configureFakeMcp(params);
    params.config!.mcp!.servers!.fake!.codex = { defaultToolsApprovalMode: "auto" };
    params.toolsAllow = ["cron", "fake__show", "fake__show-2"];
    mcpMocks.requesterCollisionTool = true;
    const requestApproval = vi.fn(async (request: { isMcpToolApprovalActive?: () => boolean }) => {
      expect(request.isMcpToolApprovalActive?.()).toBe(true);
      return { id: "plugin:mcp-dynamic" };
    });
    const waitForApproval = vi.fn(async () => ({
      decision: "allow-always" as const,
      terminalReason: "user" as const,
    }));
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      requestApproval,
      waitForApproval,
    });

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as
      | { config?: Record<string, unknown>; dynamicTools?: CodexDynamicToolSpec[] }
      | undefined;
    const dynamicNames = flattenCodexDynamicToolFunctions(threadStart?.dynamicTools).map(
      (tool) => tool.name,
    );
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      agentId: "main",
      projectedMcpServers: expect.objectContaining({ fake: expect.any(Object) }),
      requestInteractiveCodexApproval: expect.any(Function),
    });
    expect(threadStart?.config).not.toHaveProperty("mcp_servers");
    expect(dynamicNames.filter((name) => name === "fake__show")).toHaveLength(1);
    expect(dynamicNames.filter((name) => name === "fake__show-2")).toHaveLength(1);

    const requestInteractiveCodexApproval = mcpMocks.staticCalls[0]!
      .requestInteractiveCodexApproval as (params: {
      safeToolName: string;
      toolCallId: string;
      serverName: string;
      toolName: string;
      mode: "auto";
      isActive: () => boolean;
    }) => Promise<void>;
    await requestInteractiveCodexApproval({
      safeToolName: "fake__show-2",
      toolCallId: "call-fake-show",
      serverName: "fake",
      toolName: "show",
      mode: "auto",
      isActive: () => true,
    });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        mcpTool: { server: "fake", tool: "show" },
        toolCallId: "call-fake-show",
      }),
    );
    expect(waitForApproval).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();

    expect(harness.requests.map((request) => request.method)).not.toContain("mcpServerStatus/list");
    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]!.storedNames).toEqual(
      expect.arrayContaining(["fake__show", "fake__show-2"]),
    );
    expect(new Set(mcpMocks.captureCalls[0]!.storedNames).size).toBe(
      mcpMocks.captureCalls[0]!.storedNames.length,
    );
    expect(mcpMocks.captureCalls[0]!.provenance).toEqual({
      version: 1,
      source: "final-executable-surface",
    });
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
  });

  it("withholds final provenance when a sender-attributed turn cannot snapshot native MCP", async () => {
    const sessionFile = path.join(tempDir, "session-sender-attributed-mcp.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-sender-attributed-mcp"));
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    params.senderId = "external-sender";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();

    expect(mcpMocks.authorityResolvers).toHaveLength(0);
    expect(mcpMocks.captureRefs).toHaveLength(1);
    expect(mcpMocks.captureRefs[0]!.value).toBeUndefined();
    expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
  });

  it.each([
    { name: "missing", capabilityRunId: undefined },
    { name: "wrong-run", capabilityRunId: "other-run" },
    { name: "remote-management", capabilityRunId: "same-run" },
    { name: "channel-owner-management", capabilityRunId: "same-run" },
  ])(
    "does not bind $name local-operator authority at Codex tool construction",
    async (testCase) => {
      const sessionFile = path.join(tempDir, `session-local-operator-${testCase.name}.jsonl`);
      const params = createParams(
        sessionFile,
        path.join(tempDir, `workspace-local-operator-${testCase.name}`),
      );
      configureFakeMcp(params);
      params.trigger = "user";
      params.senderIsOwner = false;
      if (testCase.capabilityRunId) {
        const capability = createCronAuthorityCapabilityFixture(
          testCase.capabilityRunId === "same-run" ? params.runId : testCase.capabilityRunId,
        );
        params.cronCreatorAuthorityCapability =
          testCase.capabilityRunId === "same-run"
            ? {
                ...capability,
                callerOrigin: { kind: "unknown" },
                managementEntitlement:
                  testCase.name === "channel-owner-management"
                    ? { source: "channel-owner", isCurrent: () => true }
                    : { source: "control-ui-admin" },
              }
            : capability;
      }

      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).resolves.toBeDefined();

      expect(mcpMocks.authorityResolvers).toHaveLength(0);
    },
  );

  it("lazily snapshots configured MCP through the local-operator resolver without replacing native MCP", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = false;
    admitLocalOperatorCronAuthority(params);

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { config?: Record<string, unknown>; dynamicTools?: unknown } | undefined;
    expect(JSON.stringify(threadStart?.config ?? {})).toContain("fake");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("automations");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).not.toContain("fake__show");
    expect(mcpMocks.staticCalls).toHaveLength(0);

    expect(mcpMocks.authorityResolvers).toHaveLength(2);
    const authority = await mcpMocks.authorityResolvers[0]!();
    expect(authority.provenance).toEqual({ version: 1, source: "final-executable-surface" });
    expect(
      authority.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).toContain("fake__show");
    expect(
      authority.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).not.toContain("fake__app_only");
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      sessionId: `cron-authority:${params.runId}`,
      manifestRegistry: params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
      retireSessionRuntimeAfterDispose: true,
    });
    expect(mcpMocks.staticCalls[0]).not.toHaveProperty("sessionKey");
    expect(mcpMocks.captureCalls.at(-1)?.storedNames).toContain("fake__show");
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("offers explicit finite tools when inherited configured MCP discovery is incomplete", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-incomplete-mcp.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-incomplete-mcp"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    admitLocalOperatorCronAuthority(params);
    mcpMocks.staticDiagnosticNotice =
      "Configured MCP is incomplete for this scheduled run: fake: authentication required.";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    await expect(mcpMocks.authorityResolvers[0]!()).rejects.toThrow(
      "provide an explicit finite toolsAllow list containing only currently visible tools",
    );
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("rematerializes after one cron operation aborts pending materialization", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-aborted-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-aborted-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    admitLocalOperatorCronAuthority(params);

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const resolver = mcpMocks.authorityResolvers[0]!;
    const firstOperation = new AbortController();
    const firstResolution = resolver({ signal: firstOperation.signal });
    firstOperation.abort(new Error("first cron call timed out"));

    await expect(firstResolution).rejects.toThrow("first cron call timed out");
    const secondResolution = await resolver({ signal: new AbortController().signal });

    expect(
      secondResolution.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).toContain("fake__show");
    expect(mcpMocks.staticCalls).toHaveLength(2);
    expect(mcpMocks.dispose).toHaveBeenCalledTimes(2);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("shares one configured-MCP materialization across concurrent active cron operations", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-concurrent-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-concurrent-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    admitLocalOperatorCronAuthority(params);

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const resolver = mcpMocks.authorityResolvers[0]!;
    const firstResolution = resolver({ signal: new AbortController().signal });
    const secondResolution = resolver({ signal: new AbortController().signal });

    expect(secondResolution).toBe(firstResolution);
    const [first, second] = await Promise.all([firstResolution, secondResolution]);
    expect(second).toBe(first);
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("retains an unrelated cached timeout when its operation signal aborts concurrently", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-unrelated-timeout.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-unrelated-timeout"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    admitLocalOperatorCronAuthority(params);
    const failureGate = createDeferred<void>();
    mcpMocks.staticFailureGate = failureGate.promise;
    mcpMocks.staticFailure = Object.assign(new Error("configured MCP materialization timed out"), {
      name: "TimeoutError",
    });

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const resolver = mcpMocks.authorityResolvers[0]!;
    const operation = new AbortController();
    const firstResolution = resolver({ signal: operation.signal });
    operation.abort(new Error("cron tool call was cancelled"));
    failureGate.resolve();

    await expect(firstResolution).rejects.toThrow(
      "provide an explicit finite toolsAllow list containing only currently visible tools",
    );
    const secondResolution = resolver({ signal: new AbortController().signal });
    expect(secondResolution).toBe(firstResolution);
    await expect(secondResolution).rejects.toThrow("configured MCP materialization timed out");
    expect(mcpMocks.staticCalls).toHaveLength(1);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it.each(["current hook policy", ""])(
    "keeps post-hook static discovery failures visible with replacement policy %j",
    async (systemPrompt) => {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_prompt_build", handler: async () => ({ systemPrompt }) },
        ]),
      );
      const sessionFile = path.join(tempDir, "session-static-mcp-discovery-failure.jsonl");
      const params = createParams(
        sessionFile,
        path.join(tempDir, "workspace-static-mcp-discovery-failure"),
      );
      configureFakeMcp(params);
      params.trigger = "cron";
      params.toolsAllow = ["*"];
      params.scheduledToolPolicy = { version: 1, mode: "trusted" };
      mcpMocks.staticDiagnosticNotice =
        "Configured MCP is incomplete for this scheduled run: fake: authentication required. " +
        "Do not claim MCP-backed work succeeded; report this blocker to the operator.";

      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");

      const threadStart = harness.requests.find((request) => request.method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        developerInstructions: [systemPrompt, mcpMocks.staticDiagnosticNotice]
          .filter(Boolean)
          .join("\n\n"),
      });
      expect(harness.requests.some((request) => request.method === "thread/inject_items")).toBe(
        false,
      );
      expect(mcpMocks.captureCalls).toHaveLength(1);
      expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).resolves.toBeDefined();
      expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    },
  );
});
