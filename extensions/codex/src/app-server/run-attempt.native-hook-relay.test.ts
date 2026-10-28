import fs from "node:fs/promises";
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
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it, vi } from "vitest";
import * as approvalBridge from "./approval-bridge.js";
import { CodexAppServerRpcError } from "./client.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { rawItemCompleted } from "./protocol.test-helpers.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

function createLoopRelayParams(sessionFile: string, workspaceDir: string) {
  const params = createParams(sessionFile, workspaceDir);
  params.config = { tools: { loopDetection: { enabled: true } } };
  setRuntimeConfigSnapshot(params.config);
  return params;
}

function writeCodexAppServerBinding(...args: Parameters<typeof writeRawCodexAppServerBinding>) {
  const [sessionFile, binding, lookup] = args;
  return writeRawCodexAppServerBinding(
    sessionFile,
    {
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      ...binding,
    },
    lookup,
  );
}

const preToolUse = {
  nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
} satisfies Parameters<typeof runCodexAppServerAttempt>[1];
type RelayHarness = ReturnType<typeof createStartedThreadHarness>;
const threadRequest = (harness: RelayHarness, method = "thread/start") =>
  harness.requests.find((request) => request.method === method)?.params;

function invokeCommand(relayId: string, toolUseId: string, generation?: string, command = "pwd") {
  return invokeNativeHookRelay({
    provider: "codex",
    relayId,
    ...(generation === undefined ? {} : { generation, requireGeneration: true }),
    event: "pre_tool_use",
    rawPayload: {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: { command },
    },
  });
}

describe("runCodexAppServerAttempt native hook relay", () => {
  it("rejects Guardian review when the running server resolves an untrusted managed endpoint", async () => {
    const sessionFile = path.join(tempDir, "managed-review-endpoint.jsonl");
    const workspaceDir = path.join(tempDir, "managed-review-endpoint-workspace");
    const params = createParams(sessionFile, workspaceDir, { provider: "openai" });
    const harness = createStartedThreadHarness(async (method) =>
      method === "config/read"
        ? { config: { openai_base_url: "https://review-proxy.example.invalid/v1" }, origins: {} }
        : undefined,
    );

    await expect(
      runCodexAppServerAttempt(params, {
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).rejects.toThrow(/model-backed approval reviewer.*trusted OpenAI/i);
    expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("relays native tool results through Codex result middleware", async () => {
    const middleware = vi.fn(async () => undefined);
    const afterToolCall = vi.fn();
    const beforeAgentFinalize = vi.fn();
    const registry = createMockPluginRegistry([
      { hookName: "after_tool_call", handler: afterToolCall },
      { hookName: "before_agent_finalize", handler: beforeAgentFinalize },
    ]);
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: middleware,
      handler: middleware,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.sandboxSessionKey = "agent:main:policy";
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: {
        enabled: true,
        events: ["post_tool_use", "before_agent_finalize"],
      },
    });
    await harness.waitForMethod("turn/start");
    const startRequest = threadRequest(harness);
    const startConfig = (startRequest as { config?: Record<string, unknown> } | undefined)?.config;
    expect(startConfig?.["hooks.PostToolUse"]).not.toEqual([]);
    const relayId = extractRelayIdFromThreadRequest(startRequest);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "post_tool_use",
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "pnpm test" },
        tool_response: { output: "ok", exit_code: 0 },
      },
    });

    expect(middleware).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "native-call-1",
        toolName: "exec",
        args: { command: "pnpm test" },
        result: {
          content: [{ type: "text", text: '{\n  "output": "ok",\n  "exit_code": 0\n}' }],
          details: { output: "ok", exit_code: 0 },
        },
      }),
      expect.objectContaining({
        runtime: "codex",
        agentId: "main",
        sessionKey: params.sessionKey,
      }),
    );
    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "before_agent_finalize",
      rawPayload: { hook_event_name: "Stop", session_id: "thread-1", turn_id: "turn-1" },
    });
    for (const hook of [afterToolCall, beforeAgentFinalize]) {
      expect(hook).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ agentId: "main", sessionKey: params.sessionKey }),
      );
    }

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("auto-answers defensive yolo command and workspace file approvals once", async () => {
    const approvalSpy = vi.spyOn(approvalBridge, "handleCodexAppServerApprovalRequest");
    const beforeToolCall = vi.fn(() => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const sessionFile = path.join(tempDir, "policy-allow.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-policy-allow");
    const commandFile = path.join(workspaceDir, "byte-bound-command.mjs");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(commandFile, "process.stdout.write('ok\\n');\n");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.trigger = "user";
    params.approvalReviewerDeviceId = "device-tui-reviewer";
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);

    const run = runCodexAppServerAttempt(params, preToolUse);
    await harness.waitForMethod("turn/start");
    const startRequest = threadRequest(harness);
    expect(startRequest).toMatchObject({ approvalPolicy: "never" });
    const relayId = extractRelayIdFromThreadRequest(startRequest);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toMatchObject({
      approvalContext: {
        trigger: "user",
        approvalReviewerDeviceId: "device-tui-reviewer",
      },
    });

    const commandResponse = await harness.handleServerRequest({
      id: "request-command-policy-allow",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-policy-allow",
        command: `node ${commandFile}`,
        cwd: workspaceDir,
      },
    });
    expect(approvalSpy).toHaveBeenCalledWith(expect.objectContaining({ autoApprove: true }));
    // Commands backed by mutable file bytes cannot receive reusable approval.
    expect(commandResponse).toEqual({ decision: "accept" });
    await expect(
      harness.handleServerRequest({
        id: "request-file-policy-allow",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "patch-policy-allow",
          reason: "write memory/2026-07-29.md",
          grantRoot: workspaceDir,
        },
      }),
    ).resolves.toEqual({ decision: "accept" });

    expect(beforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "apply_patch" }),
      expect.any(Object),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    closeHostCapabilities();
    await nativeHookRelayUnregisterQueue.flush();
  });

  it("fails a defensive unattended yolo approval immediately when the hook requires review", async () => {
    const onResolution = vi.fn();
    let reviewRequestedAtMs = 0;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: vi.fn(() => {
            reviewRequestedAtMs = performance.now();
            return {
              requireApproval: {
                title: "Operator review required",
                description: "Command needs an interactive approver",
                onResolution,
              },
            };
          }),
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "policy-unattended.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-policy-unattended");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.trigger = "cron";
    params.onAgentEvent = vi.fn();
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const run = runCodexAppServerAttempt(params, preToolUse);
    await harness.waitForMethod("turn/start");
    const response = await harness.handleServerRequest({
      id: "request-command-policy-unattended",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-policy-unattended",
        // Executable binding must reach the hook without requiring an unrelated CLI installation.
        command: "node --version",
        cwd: workspaceDir,
      },
    });

    expect(response).toEqual({ decision: "decline" });
    // Binding mutable executable bytes precedes the hook; the decision must not wait for review.
    expect(reviewRequestedAtMs).toBeGreaterThan(0);
    expect(performance.now() - reviewRequestedAtMs).toBeLessThan(1_000);
    expect(onResolution).toHaveBeenCalledWith("cancelled");
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({
          status: "denied",
          message:
            "Plugin approval unavailable: cron runs have no approval-capable initiating surface.",
        }),
      }),
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    closeHostCapabilities();
    await nativeHookRelayUnregisterQueue.flush();
  });

  it("throttles default native hook relay renewal on current-turn progress", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createLoopRelayParams(sessionFile, workspaceDir),
      preToolUse,
    );
    await harness.waitForMethod("turn/start");

    const relayId = extractRelayIdFromThreadRequest(threadRequest(harness));
    const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
    if (!registration) {
      throw new Error("Expected native hook relay registration");
    }
    const firstExpiresAtMs = registration.expiresAtMs;

    for (const id of ["raw-progress-1", "raw-progress-2"]) {
      await harness.notify(
        rawItemCompleted({
          type: "message",
          id,
          role: "assistant",
          content: [{ type: "output_text", text: "Still working." }],
        }),
      );
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)?.expiresAtMs,
      ).toBe(firstExpiresAtMs);
    }

    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "foreign-thread",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "foreign-progress",
          role: "assistant",
          content: [{ type: "output_text", text: "Wrong thread." }],
        },
      },
    });
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)?.expiresAtMs,
    ).toBe(firstExpiresAtMs);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await nativeHookRelayUnregisterQueue.flush();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it.each(["replacement", "independent"])(
    "keeps the %s execution relay registered when prior cleanup is pending",
    async (kind) => {
      const sameExecutionSession = kind === "replacement";
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const firstHarness = createStartedThreadHarness(undefined, { persistedThreads: [] });
      const firstParams = createLoopRelayParams(sessionFile, workspaceDir);
      firstParams.sandboxSessionKey = "agent:main:policy";
      const firstRun = runCodexAppServerAttempt(firstParams, preToolUse);
      await firstHarness.waitForMethod("turn/start");
      await firstHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await firstRun;

      const firstStartRequest = threadRequest(firstHarness);
      const firstRelayId = extractRelayIdFromThreadRequest(firstStartRequest);
      const firstGeneration = extractGenerationFromThreadRequest(firstStartRequest);
      expect((await readCodexAppServerBinding(sessionFile))?.nativeHookRelayGeneration).toBe(
        firstGeneration,
      );
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId)?.runId,
      ).toBe("run-1");
      await expect(
        invokeCommand(firstRelayId, "late-call-1", undefined, "python3 -c 'print(\"x\")'"),
      ).rejects.toThrow("Codex session generation is no longer current");

      firstHarness.close();
      const secondHarness = sameExecutionSession
        ? createResumeHarness("thread-1")
        : createStartedThreadHarness();
      const secondParams = createLoopRelayParams(
        sameExecutionSession ? sessionFile : path.join(tempDir, "independent-session.jsonl"),
        workspaceDir,
      );
      secondParams.runId = "run-2";
      secondParams.sandboxSessionKey = firstParams.sandboxSessionKey;
      if (!sameExecutionSession) {
        secondParams.sessionId = "session-2";
        secondParams.sessionKey = "agent:main:session-2";
      }
      const secondRun = runCodexAppServerAttempt(secondParams, preToolUse);
      await secondHarness.waitForMethod("turn/start");

      const secondThreadRequest = threadRequest(
        secondHarness,
        sameExecutionSession ? "thread/resume" : "thread/start",
      );
      const secondRelayId = extractRelayIdFromThreadRequest(secondThreadRequest);
      expect(secondRelayId === firstRelayId).toBe(sameExecutionSession);
      const secondGeneration = extractGenerationFromThreadRequest(secondThreadRequest);
      expect(secondGeneration === firstGeneration).toBe(sameExecutionSession);
      const resumedRegistration =
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(secondRelayId);
      expect(resumedRegistration?.runId).toBe("run-2");
      expect(resumedRegistration?.sessionKey).toBe(secondParams.sessionKey);
      expect(resumedRegistration?.allowedEvents).toEqual(["pre_tool_use"]);
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId)?.runId,
      ).toBe(sameExecutionSession ? "run-2" : "run-1");

      await nativeHookRelayUnregisterQueue.flush();
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(secondRelayId)?.runId,
      ).toBe("run-2");

      await secondHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await secondRun;
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(secondRelayId)?.runId,
      ).toBe("run-2");
      await nativeHookRelayUnregisterQueue.flush();
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(secondRelayId),
      ).toBeUndefined();
    },
  );

  it("accepts a stale first hook generation when resuming a pre-generation binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const harness = createResumeHarness();

    const run = runCodexAppServerAttempt(
      createLoopRelayParams(sessionFile, workspaceDir),
      preToolUse,
    );
    await harness.waitForMethod("turn/start");

    const resumeRequest = threadRequest(harness, "thread/resume");
    const relayId = extractRelayIdFromThreadRequest(resumeRequest);
    const currentGeneration = extractGenerationFromThreadRequest(resumeRequest);
    expect(currentGeneration).not.toBe("legacy-generation-from-running-thread");
    await expect(
      invokeCommand(relayId, "first-tool-after-restart", "legacy-generation-from-running-thread"),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      invokeCommand(relayId, "unexpected-stale-generation", "different-legacy-generation"),
    ).rejects.toThrow("native hook relay bridge stale registration");

    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    expect((await readCodexAppServerBinding(sessionFile))?.nativeHookRelayGeneration).toBe(
      currentGeneration,
    );
    await nativeHookRelayUnregisterQueue.flush();
  });

  it.each(["configuration changed", "resume failed"] as const)(
    "rejects the old hook generation when %s starts a fresh thread",
    async (reason) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const generation = "generation-from-old-thread";
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: "gpt-5.4-codex",
        modelProvider: "openai",
        nativeHookRelayGeneration: generation,
        ...(reason === "resume failed"
          ? { dynamicToolsFingerprint: "[]" }
          : { userMcpServersFingerprint: "stale-user-mcp-fingerprint" }),
      });
      const harness = createStartedThreadHarness(
        async (method) => {
          if (method === "thread/resume") {
            throw new CodexAppServerRpcError({ code: -32_000, message: "resume failed" }, method);
          }
          return undefined;
        },
        { persistedThreads: reason === "resume failed" ? ["thread-existing"] : [] },
      );
      const run = runCodexAppServerAttempt(
        createLoopRelayParams(sessionFile, workspaceDir),
        preToolUse,
      );
      await harness.waitForMethod("turn/start");
      const start = threadRequest(harness);
      const relayId = extractRelayIdFromThreadRequest(start);
      const currentGeneration = extractGenerationFromThreadRequest(start);
      expect(currentGeneration).not.toBe(generation);
      await expect(invokeCommand(relayId, "old-thread-tool", generation)).rejects.toThrow(
        "native hook relay bridge stale registration",
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      expect((await readCodexAppServerBinding(sessionFile))?.nativeHookRelayGeneration).toBe(
        currentGeneration,
      );
      await nativeHookRelayUnregisterQueue.flush();
    },
  );

  it("cleans up native hook relay state when turn/start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    let reportPreToolUseFailure:
      | NonNullable<NativeHookRelayRegistrationHandle["onPreToolUseFailure"]>
      | undefined;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        const relayId = extractRelayIdFromThreadRequest(threadRequest(harness));
        const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
        reportPreToolUseFailure = registration?.onPreToolUseFailure;
        throw new Error("turn start exploded");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.sandboxSessionKey = "agent:main:policy";

    try {
      await expect(
        runCodexAppServerAttempt(params, {
          nativeHookRelay: { enabled: true },
        }),
      ).rejects.toThrow("turn start exploded");
      await reportPreToolUseFailure?.({
        toolName: "exec",
        toolCallId: "turn-start-failure-tool",
        disposition: "failed",
        durationMs: 5,
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      unsubscribeDiagnostics();
    }

    const relayId = extractRelayIdFromThreadRequest(threadRequest(harness));
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    expect(diagnosticEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.error",
        agentId: "main",
        sessionKey: params.sessionKey,
        toolCallId: "turn-start-failure-tool",
        terminalReason: "failed",
      }),
    );
  });
});
