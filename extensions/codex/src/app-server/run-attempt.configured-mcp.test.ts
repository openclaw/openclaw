import "./run-attempt.configured-mcp.test-support.js";
import { getEventListeners } from "node:events";
import path from "node:path";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import * as attemptContext from "./attempt-context.js";
import * as dynamicTools from "./dynamic-tools.js";
import {
  assistantMessage,
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

const { configureFakeMcp, mcpMocks, setupConfiguredMcpTestHooks } =
  await import("./run-attempt.configured-mcp.test-support.js");

setupConfiguredMcpTestHooks();

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
      expect(mcpMocks.captureCalls).toHaveLength(1);
      expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
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
    expect(mcpMocks.captureCalls).toHaveLength(1);
    expect(mcpMocks.captureCalls[0]!.storedNames).toEqual(
      expect.arrayContaining(["fake__show", "fake__show_2"]),
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
