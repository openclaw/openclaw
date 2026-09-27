import { onAgentEvent, type AgentEventPayload } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createProcessPollDeliveryContract } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  emitTrustedDiagnosticEvent,
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
import {
  emitDynamicToolStartedDiagnostic,
  emitDynamicToolTerminalDiagnostic,
} from "./dynamic-tool-diagnostics.js";
import { hasPendingDynamicToolTerminalDiagnostic } from "./dynamic-tool-execution.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import type { CodexDynamicToolCallParams } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createTestParams,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

function flushDiagnosticEvents() {
  return waitForDiagnosticEventsDrained();
}

function activeDiagnosticToolKeys(events: DiagnosticEventPayload[]): Set<string> {
  const active = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.execution.started") {
      active.add(
        `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${event.toolCallId ?? event.toolName}`,
      );
    } else if (
      event.type === "tool.execution.completed" ||
      event.type === "tool.execution.error" ||
      event.type === "tool.execution.blocked"
    ) {
      active.delete(
        `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${event.toolCallId ?? event.toolName}`,
      );
    }
  }
  return active;
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt dynamic tools", () => {
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
      const response = await harness.handleServerRequest({
        id: "process-poll",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "process-poll",
          namespace: null,
          tool: "sandbox_process",
          arguments: process.pollArguments,
        },
      });
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

  it.each([
    { name: "default", timeoutSeconds: undefined, waitMs: 900_000 },
    { name: "maximum", timeoutSeconds: 3600, waitMs: 3_600_000 },
  ])(
    "returns a credential result after the $name human wait without harness cancellation",
    async ({ timeoutSeconds, waitMs }) => {
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
        const response = harness
          .handleServerRequest({
            id: "credential-wait",
            method: "item/tool/call",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              callId: "credential-wait",
              namespace: null,
              tool: "secrets",
              arguments: {
                action: "request",
                name: "TEST_API_KEY",
                ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
              },
            },
          })
          .then((result) => {
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
    },
  );

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
      const toolResult = (await harness.handleServerRequest({
        id: "request-echo-audit",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-echo-audit",
          namespace: null,
          tool: "echo",
          arguments: {},
        },
      })) as { success?: boolean };
      expect(toolResult.success).toBe(true);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      await flushDiagnosticEvents();
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

  it.each(["cancelled", "timed_out"] as const)(
    "preserves the %s terminal reason in trusted tool diagnostics",
    async (terminalReason) => {
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
        diagnosticEvents.push(event),
      );
      const call = {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: `call-${terminalReason}`,
        namespace: null,
        tool: "lookup",
        arguments: {},
      } satisfies CodexDynamicToolCallParams;
      try {
        emitDynamicToolStartedDiagnostic({
          call,
          agentId: "agent-terminal-reason",
          runId: "run-terminal-reason",
        });
        emitDynamicToolTerminalDiagnostic({
          call,
          agentId: "agent-terminal-reason",
          runId: "run-terminal-reason",
          durationMs: 1,
          response: {
            success: false,
            diagnosticTerminalReason: terminalReason,
            contentItems: [{ type: "inputText", text: "not persisted by audit" }],
          },
        });
        await flushDiagnosticEvents();
      } finally {
        unsubscribeDiagnostics();
      }

      expect(diagnosticEvents.find((event) => event.type === "tool.execution.error")).toMatchObject(
        { agentId: "agent-terminal-reason", terminalReason },
      );
    },
  );

  it("emits normalized tool progress around app-server dynamic tool requests", async () => {
    const harness = createStartedThreadHarness();
    const onRunAgentEvent = vi.fn();
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

      const toolResult = (await harness.handleServerRequest({
        id: "request-tool-1",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: null,
          tool: "lookup",
          arguments: {
            action: "search",
            command: "cat /private/operator-file",
            token: "plain-secret-value-12345",
            text: "hello",
          },
        },
      })) as {
        contentItems?: Array<{ text?: string; type?: string }>;
        success?: boolean;
      };
      expect(toolResult.success).toBe(false);
      expect(toolResult.contentItems?.[0]?.type).toBe("inputText");
      expect(toolResult.contentItems?.[0]?.text).toMatch(/^Unknown OpenClaw tool: lookup$/u);

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      await flushDiagnosticEvents();
    } finally {
      unsubscribeDiagnostics();
    }

    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event) as Array<{
      data?: {
        args?: Record<string, unknown>;
        commandBearing?: boolean;
        isError?: boolean;
        name?: string;
        phase?: string;
        result?: {
          content?: Array<{ text?: string; type?: string; url?: string }>;
          contentItems?: unknown;
          success?: unknown;
        };
        toolCallId?: string;
      };
      stream?: string;
    }>;
    const startEvent = agentEvents.find(
      (event) => event.stream === "tool" && event.data?.phase === "start",
    );
    expect(startEvent?.data?.name).toBe("lookup");
    expect(startEvent?.data?.toolCallId).toBe("call-1");
    expect(startEvent?.data?.args?.action).toBe("search");
    expect(startEvent?.data?.commandBearing).toBe(true);
    expect(startEvent?.data?.args?.token).toBe("plain-…2345");
    expect(startEvent?.data?.args?.text).toBe("hello");
    const resultEvent = agentEvents.find(
      (event) =>
        event.stream === "tool" &&
        event.data?.phase === "result" &&
        event.data.result !== undefined,
    );
    expect(resultEvent?.data?.name).toBe("lookup");
    expect(resultEvent?.data?.commandBearing).toBe(true);
    expect(resultEvent?.data?.toolCallId).toBe("call-1");
    expect(resultEvent?.data?.isError).toBe(true);
    expect(resultEvent?.data?.result).not.toHaveProperty("success");
    expect(resultEvent?.data?.result).not.toHaveProperty("contentItems");
    expect(resultEvent?.data?.result?.content?.[0]?.type).toBe("text");
    expect(resultEvent?.data?.result?.content?.[0]?.text).toBe("Unknown OpenClaw tool: lookup");
    expect(JSON.stringify(agentEvents)).not.toContain("plain-secret-value-12345");
    const globalStartEvent = globalAgentEvents.find(
      (event) => event.stream === "tool" && event.data.phase === "start",
    );
    expect(globalStartEvent?.runId).toBe("run-1");
    expect(globalStartEvent?.sessionKey).toBe("agent:main:session-1");
    expect(globalStartEvent?.data.name).toBe("lookup");
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
    const toolDiagnosticEvents = diagnosticEvents.filter(
      (
        event,
      ): event is Extract<
        DiagnosticEventPayload,
        { type: "tool.execution.started" | "tool.execution.completed" | "tool.execution.error" }
      > => event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "lookup",
        toolCallId: "call-1",
      },
      {
        type: "tool.execution.error",
        toolName: "lookup",
        toolCallId: "call-1",
      },
    ]);
    expect(activeDiagnosticToolKeys(diagnosticEvents)).toEqual(new Set());
  });

  it("emits request-boundary terminal diagnostics when a wrapped dynamic tool does not", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    try {
      const call = {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-echo-unobserved-terminal",
        namespace: null,
        tool: "echo",
        arguments: {},
      } satisfies CodexDynamicToolCallParams;

      emitDynamicToolStartedDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        runId: "other-run",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        toolName: "echo",
        toolCallId: "call-echo-unobserved-terminal",
        durationMs: 1,
      });
      expect(
        hasPendingDynamicToolTerminalDiagnostic({
          call,
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
      ).toBe(false);

      emitDynamicToolTerminalDiagnostic({
        call,
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        durationMs: 1,
        response: {
          success: true,
          contentItems: [{ type: "inputText", text: "echo done" }],
        },
      });

      await flushDiagnosticEvents();

      const toolDiagnosticEvents = diagnosticEvents.filter(
        (
          event,
        ): event is Extract<
          DiagnosticEventPayload,
          { type: "tool.execution.started" | "tool.execution.completed" | "tool.execution.error" }
        > => event.type.startsWith("tool.execution."),
      );
      expect(
        toolDiagnosticEvents.map((event) => ({
          runId: event.runId,
          type: event.type,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        })),
      ).toEqual([
        {
          runId: "run-1",
          type: "tool.execution.started",
          toolName: "echo",
          toolCallId: "call-echo-unobserved-terminal",
        },
        {
          runId: "other-run",
          type: "tool.execution.completed",
          toolName: "echo",
          toolCallId: "call-echo-unobserved-terminal",
        },
        {
          runId: "run-1",
          type: "tool.execution.completed",
          toolName: "echo",
          toolCallId: "call-echo-unobserved-terminal",
        },
      ]);
    } finally {
      unsubscribeDiagnostics();
    }
  });

  it.each(["blocked", "error"] as const)(
    "does not duplicate terminal diagnostics for wrapped dynamic tool %s responses",
    async (terminalType) => {
      const diagnosticEvents: DiagnosticEventPayload[] = [];
      const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
        diagnosticEvents.push(event),
      );
      const context = {
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: `call-echo-${terminalType}`,
          namespace: null,
          tool: "echo",
          arguments: {},
        },
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      } satisfies Parameters<typeof emitDynamicToolStartedDiagnostic>[0];
      try {
        emitDynamicToolStartedDiagnostic(context);
        emitDynamicToolTerminalDiagnostic({
          ...context,
          durationMs: 1,
          response: {
            success: false,
            ...(terminalType === "blocked" ? { diagnosticTerminalType: terminalType } : {}),
            contentItems: [{ type: "inputText", text: "wrapped tool failed" }],
          },
        });
        expect(hasPendingDynamicToolTerminalDiagnostic(context)).toBe(true);
        await flushDiagnosticEvents();
        expect(
          diagnosticEvents
            .filter(
              (
                event,
              ): event is Extract<
                DiagnosticEventPayload,
                {
                  type:
                    | "tool.execution.started"
                    | "tool.execution.completed"
                    | "tool.execution.error"
                    | "tool.execution.blocked";
                }
              > => event.type.startsWith("tool.execution."),
            )
            .map((event) => ({
              type: event.type,
              toolName: event.toolName,
              toolCallId: event.toolCallId,
            })),
        ).toEqual([
          { type: "tool.execution.started", toolName: "echo", toolCallId: context.call.callId },
          {
            type: `tool.execution.${terminalType}`,
            toolName: "echo",
            toolCallId: context.call.callId,
          },
        ]);
      } finally {
        unsubscribeDiagnostics();
      }
    },
  );

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
      await expect(
        harness.handleServerRequest({
          id: "call-echo-1",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-echo-1",
            namespace: null,
            tool: "echo",
            arguments: {},
          },
        }),
      ).resolves.toMatchObject({ success: true });
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
