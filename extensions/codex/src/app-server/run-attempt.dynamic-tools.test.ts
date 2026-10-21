import { onAgentEvent, type AgentEventPayload } from "openclaw/plugin-sdk/agent-harness-runtime";
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
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import type { CodexDynamicToolCallParams } from "./protocol.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createTestParams,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

function callTool(
  harness: ReturnType<typeof createStartedThreadHarness>,
  tool: string,
  callId: string,
  args: CodexDynamicToolCallParams["arguments"] = {},
  requestId = callId,
) {
  return harness.handleServerRequest({
    id: requestId,
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

async function startTool(
  tool: ReturnType<typeof createRuntimeDynamicTool>,
  {
    harness = createStartedThreadHarness(),
    clock = false,
    ...overrides
  }: Partial<ReturnType<typeof createTestParams>> & {
    harness?: ReturnType<typeof createStartedThreadHarness>;
    clock?: boolean;
  } = {},
) {
  const params = Object.assign(
    createTestParams(),
    { runtimePlan: createCodexRuntimePlanFixture() },
    overrides,
  );
  setCodexTestToolFactory(params, () => [tool]);
  setCodexTestModelSupportsTools(params, true);
  onTestFinished(await bindProductionHarnessHostCapabilitiesForTest(params));
  if (clock) {
    fakeClock();
  }
  return { harness, run: runCodexAppServerAttempt(params) };
}

async function completeRun(
  harness: ReturnType<typeof createStartedThreadHarness>,
  run: ReturnType<typeof runCodexAppServerAttempt>,
) {
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
}

function expectToolResult(result: unknown, text: string) {
  expect(result).toMatchObject({
    success: true,
    contentItems: [{ type: "inputText", text: expect.stringContaining(text) }],
  });
}

function pendingTool(name: string, text: string, details: Record<string, string> = {}) {
  const started = createDeferred<void>(),
    finish = createDeferred<void>();
  let signal: AbortSignal | undefined;
  const tool = createRuntimeDynamicTool(name);
  tool.execute = vi.fn(async (_id, _args, value) => {
    signal = value;
    started.resolve();
    await finish.promise;
    return { content: [{ type: "text" as const, text }], details };
  });
  return { tool, started: started.promise, finish: finish.resolve, signal: () => signal };
}

function fakeClock() {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
}

function observeDiagnostics() {
  const events: DiagnosticEventPayload[] = [];
  onTestFinished(onInternalDiagnosticEvent((event) => events.push(event)));
  return events;
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt dynamic tools", () => {
  it.each<
    [
      string,
      number,
      CodexDynamicToolCallParams["arguments"],
      number,
      "complete" | "timeout" | "stop",
    ]
  >([
    ["default review", 1_800_000, {}, 0, "complete"],
    ["explicit multipass review", 1_800_000, { timeoutSeconds: 900, passes: 2 }, 0, "complete"],
    ["original parent deadline", 1_200_000, {}, 500_000, "timeout"],
    ["Stop with unlimited parent", MAX_TIMER_TIMEOUT_MS, {}, 0, "stop"],
  ])("keeps AutoReview and its replay within %s", async (_scenario, parentMs, args, ageMs, end) => {
    const pending = pendingTool("autoreview", "Complete canonical review report");
    const upstream = new AbortController();
    const { tool } = pending;
    tool.parameters = {
      type: "object",
      properties: { timeoutSeconds: { type: "number" }, passes: { type: "integer" } },
    };
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "turn/interrupt") {
          queueMicrotask(
            () => void harness.notify(turnCompleted({ id: "turn-1", status: "interrupted" })),
          );
        }
      },
      { persistedThreads: [] },
    );
    const { run } = await startTool(tool, {
      timeoutMs: parentMs,
      abortSignal: upstream.signal,
      harness,
      clock: true,
    });
    try {
      await run.waitForTurnAccepted();
      await vi.advanceTimersByTimeAsync(ageMs);
      let settled = 0;
      const original = callTool(harness, "autoreview", "review", args);
      void original.then(() => settled++);
      await pending.started;
      const replay = callTool(harness, "autoreview", "review", args, "review-replay");
      void replay.then(() => settled++);
      await vi.advanceTimersByTimeAsync(690_000);
      expect(settled).toBe(0);
      expect(pending.signal()?.aborted).toBe(false);
      expect(tool.execute).toHaveBeenCalledOnce();
      if (end === "timeout") {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pending.signal()?.aborted).toBe(true);
      } else if (end !== "complete") {
        upstream.abort(new Error("Stopped by user"));
        expect(pending.signal()?.aborted).toBe(true);
      }
      pending.finish();
      const [result, repeated] = await Promise.all([original, replay]);
      expect(repeated).toEqual(result);
      expect(result).toMatchObject({ success: end === "complete" });
      if (end === "complete") {
        expect(result).toMatchObject({
          contentItems: [{ type: "inputText", text: "Complete canonical review report" }],
        });
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      }
      expect(readAttemptTerminal(await run)).toMatchObject({
        timedOut: end === "timeout",
        aborted: end !== "complete",
      });
    } finally {
      pending.finish();
      harness.close();
      await run;
      vi.useRealTimers();
    }
  });

  it("prepares hosted search policy for a recovered dashboard turn", async () => {
    // Restart recovery resumes Control UI sessions before the Gateway projection
    // serves their just-rewritten rows, so policy must prepare its own facts.
    vi.stubEnv("OPENCLAW_STATE_DIR", `${tempDir}/state`);
    const sessionKey = "agent:main:dashboard:recovered";
    const harness = createStartedThreadHarness();
    const params = Object.assign(createTestParams(), {
      sessionKey,
      sandboxSessionKey: sessionKey,
      config: {},
      inputProvenance: {
        kind: "internal_system" as const,
        sourceSessionKey: sessionKey,
        sourceTool: "main_session_restart_recovery",
      },
    });
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("message")]);
    setRuntimeConfigSnapshot(params.config);
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await completeRun(harness, run);
  });

  it("retains a required command as one native pending call until terminal collection", async () => {
    const command = createRequiredExecRuntimeContract();
    // Keep fixture I/O from spending the attempt clock before the command starts.
    const { harness, run } = await startTool(
      { ...command.tool, name: "sandbox_exec" },
      { clock: true },
    );
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
      expectToolResult(await response, "REQUIRED_NATIVE_RESULT");
      await completeRun(harness, run);
    } finally {
      vi.useRealTimers();
      command.finish();
      await response;
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
    const { run } = await startTool(
      {
        ...process.tool,
        name: "sandbox_process",
      },
      { harness, clock: true },
    );
    // Protocol acceptance owns this test; host I/O must not spend the execution watchdog.
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
      expectToolResult(response, "completed output");
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
        await completeRun(harness, run);
      } finally {
        vi.useRealTimers();
        process.close();
      }
    }
  });

  it("returns a credential result after the maximum human wait without harness cancellation", async () => {
    const waitMs = 3_600_000;
    const pending = pendingTool("secrets", "Credential request expired; no_answer.", {
      status: "no_answer",
    });
    const { tool } = pending;
    tool.parameters = {
      type: "object",
      properties: {
        action: { type: "string" },
        name: { type: "string" },
        timeoutSeconds: { type: "integer" },
      },
    };
    const { harness, run } = await startTool(tool, {
      timeoutMs: waitMs + 120_000,
    });
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
      await pending.started;
      await vi.advanceTimersByTimeAsync(waitMs);
      expect(settled).toBe(false);
      expect(pending.signal()?.aborted).toBe(false);
      pending.finish();
      expectToolResult(await response, "no_answer");
      await completeRun(harness, run);
    } finally {
      pending.finish();
      vi.useRealTimers();
    }
  });

  it("emits one eager audit lifecycle when runtime normalization clones a wrapped tool", async () => {
    const events = observeDiagnostics();
    const isStart = (event: DiagnosticEventPayload) =>
      event.type === "tool.execution.started" && event.toolCallId === "call-echo-audit";
    let hasStarted = false;
    const tool = createRuntimeDynamicTool("echo");
    const execute = vi.fn(async () => {
      hasStarted = events.some(isStart) || hasPendingInternalDiagnosticEvent(isStart);
      return {
        content: [{ type: "text" as const, text: "echo done" }],
        details: {},
      };
    });
    tool.execute = execute;

    const runtimePlan = createCodexRuntimePlanFixture();
    const attempt = await startTool(tool, {
      runtimePlan: {
        ...runtimePlan,
        tools: {
          ...runtimePlan.tools,
          normalize: (tools) => tools.map((entry) => ({ ...entry })),
        },
      },
    });
    const { harness, run } = attempt;
    await harness.waitForMethod("turn/start");
    expect(await callTool(harness, "echo", "call-echo-audit")).toMatchObject({ success: true });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await waitForDiagnosticEventsDrained();

    expect(execute).toHaveBeenCalledOnce();
    expect(hasStarted).toBe(true);
    expect(
      events
        .filter((event) => "toolCallId" in event && event.toolCallId === "call-echo-audit")
        .map((event) => event.type),
    ).toEqual(["tool.execution.started", "tool.execution.completed"]);
  });

  it("emits normalized tool progress around app-server dynamic tool requests", async () => {
    const harness = createStartedThreadHarness();
    const onEvent = vi.fn<NonNullable<ReturnType<typeof createTestParams>["onAgentEvent"]>>();
    const onPhase = vi.fn();
    const globals: AgentEventPayload[] = [];
    const diagnostics = observeDiagnostics();
    onAgentEvent((event) => globals.push(event));
    const identity = { name: "lookup", toolCallId: "call-1", commandBearing: true };
    const errorText = "Unknown OpenClaw tool: lookup";
    const params = createTestParams();
    params.onAgentEvent = onEvent;
    params.onExecutionPhase = onPhase;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("thread/start");
    await vi.waitFor(() =>
      expect(onPhase).toHaveBeenCalledWith(expect.objectContaining({ phase: "turn_accepted" })),
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
      contentItems: [{ type: "inputText", text: errorText }],
    });

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await waitForDiagnosticEventsDrained();

    const events = onEvent.mock.calls.map(([event]) => event);
    const toolEvent = (phase: string) =>
      events.find((event) => event.stream === "tool" && event.data.phase === phase);
    expect(toolEvent("start")?.data).toMatchObject({
      ...identity,
      args: { action: "search", token: "plain-secret-value-12345", text: "hello" },
    });
    const resultEvent = events.find(
      (event) =>
        event.stream === "tool" && event.data.phase === "result" && event.data.result !== undefined,
    );
    expect(resultEvent?.data).toMatchObject({
      ...identity,
      isError: true,
      result: { content: [{ type: "text", text: errorText }] },
    });
    expect(resultEvent?.data.result).not.toHaveProperty("success");
    expect(resultEvent?.data.result).not.toHaveProperty("contentItems");
    expect(JSON.stringify(events)).toContain("plain-secret-value-12345");
    expect(
      globals.find((event) => event.stream === "tool" && event.data.phase === "start"),
    ).toMatchObject({
      runId: "run-1",
      sessionKey: "agent:main:session-1",
      data: { name: "lookup" },
    });
    const model = { provider: "codex", model: "gpt-5.4-codex", backend: "codex-app-server" };
    expect(onPhase).toHaveBeenCalledWith({
      phase: "turn_accepted",
      ...model,
    });
    expect(onPhase).toHaveBeenCalledWith({
      phase: "tool_execution_started",
      ...model,
      tool: "lookup",
      toolCallId: "call-1",
    });
    expect(diagnostics.filter((event) => event.type.startsWith("tool.execution."))).toMatchObject([
      { type: "tool.execution.started", runId: "run-1", toolName: "lookup", toolCallId: "call-1" },
      { type: "tool.execution.error", runId: "run-1", toolName: "lookup", toolCallId: "call-1" },
    ]);
  });

  it("passes normalized channel context to app-server dynamic tool result hooks", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );

    const { harness, run } = await startTool(createRuntimeDynamicTool("echo"), {
      messageChannel: "telegram",
      messageProvider: "telegram",
      currentChannelId: "telegram:-100123",
      sandboxSessionKey: "agent:main:policy",
    });
    await harness.waitForMethod("turn/start");
    await expect(callTool(harness, "echo", "call-echo-1")).resolves.toMatchObject({
      success: true,
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expect(readAttemptTerminal(await run).promptError).toBeNull();

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
