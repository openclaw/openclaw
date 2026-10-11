import path from "node:path";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  onAgentEvent,
  type AgentEventPayload,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createProcessPollDeliveryContract,
  createRequiredExecRuntimeContract,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  hasPendingInternalDiagnosticEvent,
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import type { CodexDynamicToolCallParams } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createAppServerHarness,
  createParams,
  createTestParams,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  fastWait,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";

function callTool(
  harness: ReturnType<typeof createStartedThreadHarness>,
  tool: string,
  callId: string,
  args: CodexDynamicToolCallParams["arguments"] = {},
) {
  return harness.handleServerRequest({
    id: callId,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId,
      namespace: null,
      tool,
      arguments: args,
    },
  });
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt dynamic tools", () => {
  it("retains a required command as one native pending call until terminal collection", async () => {
    const command = createRequiredExecRuntimeContract();
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    setCodexTestToolFactory(params, () => [{ ...command.tool, name: "sandbox_exec" }]);
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    // Keep fixture I/O from spending the attempt clock before the command starts.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const run = runCodexAppServerAttempt(params);
    let response: ReturnType<typeof callTool> | undefined;
    try {
      await harness.waitForMethod("turn/start");
      let collected = false;
      response = callTool(harness, "sandbox_exec", "required-command", {
        command: "verify-required",
        awaitResults: true,
        yieldMs: 10,
      }).then((value) => {
        collected = true;
        return value;
      });
      await command.started;
      await vi.advanceTimersByTimeAsync(20);
      expect(collected).toBe(false);
      expect(command.spawn).toHaveBeenCalledOnce();
      expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
      command.finish();
      await expect(response).resolves.toMatchObject({
        success: true,
        contentItems: [
          { type: "inputText", text: expect.stringContaining("REQUIRED_NATIVE_RESULT") },
        ],
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
    } finally {
      vi.useRealTimers();
      command.finish();
      await response;
      closeHost();
      command.close();
    }
  });

  it("acknowledges a terminal sandbox process poll only after Codex accepts its exact result", async () => {
    const process = createProcessPollDeliveryContract("codex-result-delivery");
    const turnStarted = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        turnStarted.resolve();
      }
    });
    const params = createTestParams();
    setCodexTestToolFactory(params, () => [{ ...process.tool, name: "sandbox_process" }]);
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
    // Protocol acceptance owns this test; host I/O must not spend the execution watchdog.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const run = runCodexAppServerAttempt(params);
    try {
      await Promise.race([
        turnStarted.promise,
        run.then((result) => {
          throw new Error("Attempt ended before turn/start", { cause: result });
        }),
      ]);
      const response = await callTool(
        harness,
        "sandbox_process",
        "process-poll",
        process.pollArguments,
      );
      expect(response).toMatchObject({
        success: true,
        contentItems: [{ type: "inputText", text: expect.stringContaining("completed output") }],
      });
      expect(process.pendingNotifications()).toEqual(["unrelated event", "exec completed"]);
      const completed = (turnId: string, result: unknown) => ({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId,
          item: {
            type: "dynamicToolCall",
            id: "process-poll",
            tool: "sandbox_process",
            ...(result as object),
          },
        },
      });
      await harness.notify(completed("old-turn", response));
      await harness.notify(
        completed("turn-1", {
          success: false,
          contentItems: [{ type: "inputText", text: "Could not decode tool response" }],
        }),
      );
      expect(process.pendingNotifications()).toEqual(["unrelated event", "exec completed"]);
      await harness.notify(completed("turn-1", response));
      expect(process.pendingNotifications()).toEqual(["unrelated event"]);
    } finally {
      try {
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
      } finally {
        vi.useRealTimers();
        closeHostCapabilities();
        process.close();
      }
    }
  });

  it("returns a credential result after the maximum human wait without harness cancellation", async () => {
    const waitMs = 3_600_000;
    const tool = createRuntimeDynamicTool("secrets");
    tool.parameters = {
      type: "object",
      properties: {
        action: { type: "string" },
        name: { type: "string" },
        timeoutSeconds: { type: "integer" },
      },
    };
    let toolSignal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    tool.execute = vi.fn(async (_id, _args, signal) => {
      toolSignal = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        content: [{ type: "text" as const, text: "Credential request expired; no_answer." }],
        details: { status: "no_answer" },
      };
    });

    const harness = createStartedThreadHarness();
    const params = createTestParams();
    setCodexTestToolFactory(params, () => [tool]);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.timeoutMs = waitMs + 120_000;
    setCodexTestModelSupportsTools(params, true);
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    try {
      await harness.waitForMethod("turn/start");
      // Start I/O on real time; control only the active tool's deadline.
      vi.useFakeTimers();
      let settled = false;
      const response = callTool(harness, "secrets", "credential-wait", {
        action: "request",
        name: "TEST_API_KEY",
        timeoutSeconds: 3600,
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      await vi.advanceTimersByTimeAsync(waitMs);
      expect(settled).toBe(false);
      expect(toolSignal?.aborted).toBe(false);
      finish?.();
      await expect(response).resolves.toMatchObject({
        success: true,
        contentItems: [{ type: "inputText", text: expect.stringContaining("no_answer") }],
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
    } finally {
      finish?.();
      vi.useRealTimers();
      closeHostCapabilities();
    }
  });

  it("emits one eager audit lifecycle when runtime normalization clones a wrapped tool", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    let startPresentAtImplementation = false;
    const tool = createRuntimeDynamicTool("echo");
    const execute = vi.fn(async () => {
      startPresentAtImplementation =
        diagnosticEvents.some(
          (event) =>
            event.type === "tool.execution.started" && event.toolCallId === "call-echo-audit",
        ) ||
        hasPendingInternalDiagnosticEvent(
          (event) =>
            event.type === "tool.execution.started" && event.toolCallId === "call-echo-audit",
        );
      return {
        content: [{ type: "text" as const, text: "echo done" }],
        details: {},
      };
    });
    tool.execute = execute;

    const harness = createStartedThreadHarness();
    let closeHostCapabilities: (() => void) | undefined;
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) => {
      if ("toolCallId" in event && event.toolCallId === "call-echo-audit") {
        diagnosticEvents.push(event);
      }
    });
    try {
      const params = createTestParams();
      setCodexTestToolFactory(params, () => [tool]);
      setCodexTestModelSupportsTools(params, true);
      closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
      const runtimePlan = createCodexRuntimePlanFixture();
      params.runtimePlan = {
        ...runtimePlan,
        tools: {
          ...runtimePlan.tools,
          normalize: (tools) => tools.map((entry) => ({ ...entry })),
        },
      };

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      expect(await callTool(harness, "echo", "call-echo-audit")).toMatchObject({ success: true });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      await waitForDiagnosticEventsDrained();
    } finally {
      closeHostCapabilities?.();
      unsubscribeDiagnostics();
    }

    expect(execute).toHaveBeenCalledOnce();
    expect(startPresentAtImplementation).toBe(true);
    expect(diagnosticEvents.map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
  });

  it("emits normalized tool progress around app-server dynamic tool requests", async () => {
    const harness = createStartedThreadHarness();
    const onRunAgentEvent =
      vi.fn<NonNullable<ReturnType<typeof createTestParams>["onAgentEvent"]>>();
    const onExecutionPhase = vi.fn();
    const globalAgentEvents: AgentEventPayload[] = [];
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    onAgentEvent((event) => globalAgentEvents.push(event));
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    try {
      const params = createTestParams();
      params.onAgentEvent = onRunAgentEvent;
      params.onExecutionPhase = onExecutionPhase;

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("thread/start");
      await vi.waitFor(() =>
        expect(onExecutionPhase).toHaveBeenCalledWith(
          expect.objectContaining({ phase: "turn_accepted" }),
        ),
      );

      expect(
        await callTool(harness, "lookup", "call-1", {
          action: "search",
          command: "cat /private/operator-file",
          token: "plain-secret-value-12345",
          text: "hello",
        }),
      ).toMatchObject({
        success: false,
        contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: lookup" }],
      });

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribeDiagnostics();
    }

    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event);
    const startEvent = agentEvents.find(
      (event) => event.stream === "tool" && event.data.phase === "start",
    );
    expect(startEvent?.data).toMatchObject({
      name: "lookup",
      toolCallId: "call-1",
      commandBearing: true,
      args: { action: "search", token: "plain-…2345", text: "hello" },
    });
    const resultEvent = agentEvents.find(
      (event) =>
        event.stream === "tool" && event.data.phase === "result" && event.data.result !== undefined,
    );
    expect(resultEvent?.data).toMatchObject({
      name: "lookup",
      commandBearing: true,
      toolCallId: "call-1",
      isError: true,
      result: { content: [{ type: "text", text: "Unknown OpenClaw tool: lookup" }] },
    });
    expect(resultEvent?.data.result).not.toHaveProperty("success");
    expect(resultEvent?.data.result).not.toHaveProperty("contentItems");
    expect(JSON.stringify(agentEvents)).not.toContain("plain-secret-value-12345");
    expect(
      globalAgentEvents.find((event) => event.stream === "tool" && event.data.phase === "start"),
    ).toMatchObject({
      runId: "run-1",
      sessionKey: "agent:main:session-1",
      data: { name: "lookup" },
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "turn_accepted",
      provider: "codex",
      model: "gpt-5.4-codex",
      backend: "codex-app-server",
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "tool_execution_started",
      provider: "codex",
      model: "gpt-5.4-codex",
      backend: "codex-app-server",
      tool: "lookup",
      toolCallId: "call-1",
    });
    expect(
      diagnosticEvents.filter((event) => event.type.startsWith("tool.execution.")),
    ).toMatchObject([
      { type: "tool.execution.started", runId: "run-1", toolName: "lookup", toolCallId: "call-1" },
      { type: "tool.execution.error", runId: "run-1", toolName: "lookup", toolCallId: "call-1" },
    ]);
  });

  it("passes normalized channel context to app-server dynamic tool result hooks", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );

    const params = createTestParams();
    params.messageChannel = "telegram";
    params.messageProvider = "telegram";
    params.currentChannelId = "telegram:-100123";
    params.sandboxSessionKey = "agent:main:policy";
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("echo")]);
    const harness = createStartedThreadHarness();
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    try {
      await harness.waitForMethod("turn/start");
      await expect(callTool(harness, "echo", "call-echo-1")).resolves.toMatchObject({
        success: true,
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect(readAttemptTerminal(await run).promptError).toBeNull();
    } finally {
      closeHostCapabilities();
    }

    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledTimes(1);
    });
    expect(afterToolCall.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        channelId: "-100123",
        toolName: "echo",
        toolCallId: "call-echo-1",
      }),
    );
  });
});

type CatalogCaller = Partial<
  Pick<
    EmbeddedRunAttemptParams,
    "clientCaps" | "taskSuggestionDeliveryMode" | "toolCatalogClientFacts" | "messageChannel"
  >
>;

const CONTROL_UI_CALLER: CatalogCaller = {
  clientCaps: ["tool-events", "inline-widgets", "ui-commands", "task-suggestions"],
  taskSuggestionDeliveryMode: "gateway",
};
const RECORDED_CONTROL_UI_FACTS = {
  clientCaps: ["inline-widgets", "ui-commands"],
  taskSuggestionDeliveryMode: "gateway" as const,
};
const CLIENT_GATED_TOOLS = ["dismiss_task", "screen", "show_widget", "suggest_task"];

function createCatalogSessionHarness() {
  let threads = 0;
  let turns = 0;
  return createAppServerHarness(
    async (method, requestParams) => {
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "thread/start") {
        return threadStartResult(`thread-${++threads}`);
      }
      if (method === "thread/resume") {
        return threadStartResult((requestParams as { threadId: string }).threadId);
      }
      if (method === "turn/start") {
        return turnStartResult(`turn-${++turns}`);
      }
      return {};
    },
    { persistedThreads: ["thread-1", "thread-2"] },
  );
}

type CatalogSessionHarness = ReturnType<typeof createCatalogSessionHarness>;

// Each turn ran on this thread; a catalog rotation shows up as a second thread id.
function turnThreadIds(harness: CatalogSessionHarness): string[] {
  return harness.requests
    .filter(({ method }) => method === "turn/start")
    .map(({ params }) => (params as { threadId: string }).threadId);
}

function declaredToolNames(harness: CatalogSessionHarness): string[] {
  const start = harness.requests.find(({ method }) => method === "thread/start");
  return [...JSON.stringify(start?.params).matchAll(/"name":"([^"]+)"/g)].map((match) => match[1]!);
}

// Runs one turn of the shared session with real core tool assembly, narrowed to
// the client-gated tools plus one ungated tool.
async function runCatalogTurn(
  harness: CatalogSessionHarness,
  index: number,
  caller: CatalogCaller,
  duringTurn?: (threadId: string) => Promise<void>,
) {
  const params = createParams(
    path.join(tempDir, "session.jsonl"),
    path.join(tempDir, "workspace"),
    {
      prompt: `turn ${index}`,
      runId: `run-${index}`,
    },
  );
  Object.assign(params, caller);
  setCodexTestToolFactory(params, (options) =>
    createOpenClawCodingTools(options).filter((tool) =>
      [...CLIENT_GATED_TOOLS, "message"].includes(tool.name),
    ),
  );
  params.runtimePlan = createCodexRuntimePlanFixture();
  setCodexTestModelSupportsTools(params, true);
  const run = runCodexAppServerAttempt(params);
  await vi.waitFor(() => expect(turnThreadIds(harness)).toHaveLength(index), fastWait);
  const threadId = turnThreadIds(harness).at(-1)!;
  await duringTurn?.(threadId);
  await harness.completeTurn({ threadId, turnId: `turn-${index}` });
  await run;
}

describe("runCodexAppServerAttempt tool catalog across callers", () => {
  it("keeps one thread across Control UI and internal turns and refuses UI-only tools", async () => {
    const harness = createCatalogSessionHarness();

    await runCatalogTurn(harness, 1, CONTROL_UI_CALLER);
    await runCatalogTurn(
      harness,
      2,
      { clientCaps: [], toolCatalogClientFacts: RECORDED_CONTROL_UI_FACTS },
      async (threadId) => {
        expect(threadId).toBe("thread-1");
        for (const tool of CLIENT_GATED_TOOLS) {
          const call = { callId: `call-${tool}`, namespace: "openclaw", tool, arguments: {} };
          const response = await harness.handleServerRequest({
            id: `request-${tool}`,
            method: "item/tool/call",
            params: { threadId, turnId: "turn-2", ...call },
          });
          expect(response).toEqual({
            success: false,
            contentItems: [
              { type: "inputText", text: `OpenClaw tool is not available for this turn: ${tool}` },
            ],
          });
          // Codex settles the call item after accepting the response.
          await harness.notify({
            method: "item/completed",
            params: {
              threadId,
              turnId: "turn-2",
              item: {
                type: "dynamicToolCall",
                id: call.callId,
                status: "failed",
                ...call,
                ...response,
              },
            },
          });
        }
      },
    );

    expect(declaredToolNames(harness)).toEqual(expect.arrayContaining(CLIENT_GATED_TOOLS));
    expect(turnThreadIds(harness)).toEqual(["thread-1", "thread-1"]);
  });

  it("keeps a session without recorded client facts on its channel catalog", async () => {
    const harness = createCatalogSessionHarness();

    await runCatalogTurn(harness, 1, { messageChannel: "telegram" });
    await runCatalogTurn(harness, 2, { messageChannel: "telegram", clientCaps: [] });

    expect(declaredToolNames(harness).filter((name) => CLIENT_GATED_TOOLS.includes(name))).toEqual(
      [],
    );
    expect(turnThreadIds(harness)).toEqual(["thread-1", "thread-1"]);
  });
});
