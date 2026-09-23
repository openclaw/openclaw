import { getEventListeners } from "node:events";
import path from "node:path";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginMetadataSnapshotFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mcpMocks = vi.hoisted(() => ({
  dispose: vi.fn(async () => undefined),
  staticFacade: vi.fn(),
  threadConfigFacade: vi.fn(),
  requesterCalls: 0,
  requesterCollisionTool: false,
  requesterDispose: vi.fn(async () => undefined),
  requesterParams: [] as Array<Record<string, unknown>>,
  staticDiagnosticNotice: undefined as string | undefined,
  staticFailure: undefined as Error | undefined,
  staticFailureGate: undefined as Promise<void> | undefined,
  staticCalls: [] as Array<Record<string, unknown>>,
  staticToolExecutes: [] as ReturnType<typeof vi.fn>[],
  threadConfigCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    materializeRequesterScopedMcpToolsForHarnessRun: async (
      ...args: Parameters<typeof actual.materializeRequesterScopedMcpToolsForHarnessRun>
    ) => {
      mcpMocks.requesterCalls += 1;
      const params = args[0] as Record<string, unknown>;
      mcpMocks.requesterParams.push(params);
      if (!mcpMocks.requesterCollisionTool) {
        return undefined;
      }
      const reserved = new Set(params.reservedToolNames as string[] | undefined);
      const name = reserved.has("fake__show") ? "fake__show_2" : "fake__show";
      const tool = {
        name,
        description: "Requester-scoped MCP collision fixture.",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "scoped" }] })),
      };
      return {
        tools: [tool],
        advertisedTools: [tool],
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
        userStaticServerNames: staticServerNames,
      };
    },
  };
});

vi.mock("openclaw/plugin-sdk/codex-mcp-projection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/codex-mcp-projection")>();
  return {
    ...actual,
    materializeStaticMcpToolsForHarnessRun: async (params: Record<string, unknown>) => {
      mcpMocks.staticCalls.push(params);
      mcpMocks.staticFacade(params);
      if (mcpMocks.staticFailure) {
        await mcpMocks.staticFailureGate;
        throw mcpMocks.staticFailure;
      }
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "initial-result" }],
        details: { status: "ok" },
      }));
      mcpMocks.staticToolExecutes.push(execute);
      return {
        tools: mcpMocks.staticDiagnosticNotice
          ? []
          : [
              {
                name: "fake__show",
                description: "Show the configured MCP fixture result.",
                parameters: { type: "object", properties: {} },
                execute,
              },
            ],
        appTools: [
          {
            name: "fake__app_only",
            description: "App-view-only configured MCP fixture.",
            parameters: { type: "object", properties: {} },
            execute,
          },
        ],
        ...(mcpMocks.staticDiagnosticNotice
          ? { diagnosticNotice: mcpMocks.staticDiagnosticNotice }
          : {}),
        dispose: mcpMocks.dispose,
      };
    },
  };
});

import * as attemptContext from "./attempt-context.js";
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
  mcpMocks.staticCalls.length = 0;
  mcpMocks.staticToolExecutes.length = 0;
  mcpMocks.requesterCalls = 0;
  mcpMocks.requesterCollisionTool = false;
  mcpMocks.requesterParams.length = 0;
  mcpMocks.threadConfigCalls.length = 0;
  mcpMocks.staticDiagnosticNotice = undefined;
  mcpMocks.staticFailure = undefined;
  mcpMocks.staticFailureGate = undefined;
  mcpMocks.dispose.mockClear();
  mcpMocks.requesterDispose.mockClear();
  mcpMocks.staticFacade.mockClear();
  mcpMocks.threadConfigFacade.mockClear();
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

  it.each(["user", "cron"] as const)("keeps configured MCP native for %s runs", async (trigger) => {
    const sessionFile = path.join(tempDir, "session-" + trigger + ".jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-" + trigger));
    configureFakeMcp(params);
    params.trigger = trigger;
    if (trigger === "cron") {
      params.scheduledToolPolicy = { version: 1, mode: "trusted" };
    }
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const request = harness.requests.find((entry) => entry.method === "thread/start");
    const start = request?.params as
      | { config?: Record<string, unknown>; dynamicTools?: unknown }
      | undefined;
    // Scheduling must not move MCP into gateway wrappers or disable the native
    // environment. That changes both authentication and where shell work runs.
    expect(start?.config).toMatchObject({ mcp_servers: { fake: { command: process.execPath } } });
    expect(mcpMocks.requesterCalls).toBe(1);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("still disables native MCP and shell for an actually restricted turn", async () => {
    const sessionFile = path.join(tempDir, "session-restricted.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-restricted"));
    configureFakeMcp(params);
    params.toolsAllow = ["cron"];
    params.pluginHarnessToolPolicyRestricted = true;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "config/read") {
        return { config: { mcp_servers: { fake: { enabled: true } } }, origins: {}, layers: [] };
      }
      if (method === "mcpServerStatus/list") {
        return { data: [{ name: "fake", tools: {}, serverInfo: null }], nextCursor: null };
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(params);
    await Promise.race([
      harness.waitForMethod("turn/start"),
      run.then((result) => {
        throw new Error(`restricted turn finished before turn/start: ${JSON.stringify(result)}`);
      }),
    ]);
    const request = harness.requests.find((entry) => entry.method === "thread/start");
    expect((request?.params as { config?: unknown })?.config).toMatchObject({
      "features.shell_tool": false,
      mcp_servers: { fake: { enabled: false } },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("preserves conversation history when a legacy scheduled MCP binding returns to native ownership", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-mcp-ownership-continuity.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-scheduled-mcp-ownership-continuity");
    const cutoff = Date.now();
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-scheduled-old",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      configuredMcpOwnershipVersion: 1,
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
    params.scheduledToolPolicy = { version: 1, mode: "trusted" };
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-scheduled-old",
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

    expect(harness.requests.map((entry) => entry.method)).toContain("thread/start");
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
    },
  );

  it("keeps configured and requester MCP unique when the native surface is unavailable", async () => {
    const sessionFile = path.join(tempDir, "session-native-mcp-restricted.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-native-mcp-restricted"));
    configureFakeMcp(params);
    params.config!.mcp!.servers!.fake!.codex = { defaultToolsApprovalMode: "auto" };
    params.toolsAllow = ["cron", "fake__show"];
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
      ?.params as { config?: Record<string, unknown>; dynamicTools?: unknown } | undefined;
    const serializedDynamicTools = JSON.stringify(threadStart?.dynamicTools ?? []);
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      agentId: "main",
      projectedMcpServers: expect.objectContaining({ fake: expect.any(Object) }),
      requestInteractiveCodexApproval: expect.any(Function),
    });
    expect(threadStart?.config).not.toHaveProperty("mcp_servers");
    expect(serializedDynamicTools.match(/fake__show"/gu)).toHaveLength(1);
    expect(serializedDynamicTools.match(/fake__show_2"/gu)).toHaveLength(1);

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
      safeToolName: "fake__show",
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
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();
    expect(mcpMocks.requesterDispose).toHaveBeenCalledOnce();
  });
});
