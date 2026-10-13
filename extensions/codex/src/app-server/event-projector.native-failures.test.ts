import { createContractToolTerminalObserver } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  vi,
  createMockPluginRegistry,
  flushDiagnosticEvents,
  initializeGlobalHookRunner,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  findAgentEvent,
  requireRecord,
  mockCallArg,
  forCurrentTurn,
  readAttemptTerminal,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";
import { codexApprovalTimeoutText } from "./plugin-approval-roundtrip.js";

function notify(
  projector: Awaited<ReturnType<typeof createProjector>>,
  method: Parameters<typeof forCurrentTurn>[0],
  params: Record<string, unknown>,
) {
  return projector.handleNotification(forCurrentTurn(method, params));
}

registerCodexEventProjectorTestLifecycle();

const diagnosticEvents: DiagnosticEventPayload[] = [];
let unsubscribeDiagnostics: (() => void) | undefined;
beforeEach(() => {
  diagnosticEvents.length = 0;
  unsubscribeDiagnostics = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
});
afterEach(() => unsubscribeDiagnostics?.());

const nativeCommand = {
  type: "commandExecution" as const,
  command: "pnpm test extensions/codex",
  cwd: "/workspace",
  processId: null,
  source: "agent" as const,
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
};

describe("CodexAppServerEventProjector native tool failure recovery", () => {
  it("orders declined native tool diagnostics after their start event", async () => {
    const onAgentEvent = vi.fn();
    const observeToolTerminal = vi.fn(
      createContractToolTerminalObserver("run-codex-native-declined"),
    );
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
      observeToolTerminal,
    });

    await notify(projector, "item/started", {
      item: {
        ...nativeCommand,
        id: "cmd-declined",
        status: "inProgress",
        durationMs: null,
      },
    });
    await notify(projector, "item/completed", {
      item: {
        ...nativeCommand,
        id: "cmd-declined",
        status: "declined",
        durationMs: 1,
      },
    });
    await flushDiagnosticEvents();

    const toolDiagnosticEvents = diagnosticEvents.filter(
      (event): event is Extract<DiagnosticEventPayload, { type: `tool.execution.${string}` }> =>
        event.type.startsWith("tool.execution."),
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
        toolName: "bash",
        toolCallId: "cmd-declined",
      },
      {
        type: "tool.execution.blocked",
        toolName: "bash",
        toolCallId: "cmd-declined",
      },
    ]);
    expect(
      findAgentEvent(onAgentEvent, { stream: "item", phase: "end", itemId: "cmd-declined" }).data,
    ).toMatchObject({
      kind: "command",
      name: "bash",
      status: "blocked",
      suppressChannelProgress: true,
    });
    expect(
      findAgentEvent(onAgentEvent, {
        stream: "tool",
        phase: "result",
        itemId: "cmd-declined",
        name: "bash",
      }).data,
    ).toMatchObject({ toolCallId: "cmd-declined", status: "blocked", isError: true });
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual({
      toolName: "bash",
      meta: "run tests (workspace)",
      error: "codex native tool blocked",
      executionStarted: false,
      mutatingAction: false,
    });
    expect(observeToolTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        executionStarted: false,
        nativeMutation: { mutatingAction: false, replaySafe: true },
        outcome: "failure",
      }),
    );
  });

  it("persists an approval timeout as failed tool evidence without aborting the turn", async () => {
    const afterToolCall = vi.fn();
    const recordTrajectoryEvent = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector(undefined, {
      trajectoryRecorder: { recordEvent: recordTrajectoryEvent, flush: vi.fn() },
    });
    const item = {
      ...nativeCommand,
      id: "cmd-approval-timeout",
    };
    const timeoutExplanation = codexApprovalTimeoutText("command");

    await notify(projector, "item/started", {
      item: { ...item, status: "inProgress", durationMs: null },
    });
    projector.recordNativeToolApprovalFailure(item.id, "timed_out", "command");
    await notify(projector, "item/completed", {
      item: { ...item, status: "declined", durationMs: 1 },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = result.messagesSnapshot.find(
      (message) => message.role === "toolResult" && message.toolCallId === item.id,
    );
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: item.id,
      isError: true,
      content: [{ type: "text", text: timeoutExplanation }],
    });
    expect(result.lastToolError).toMatchObject({
      toolName: "bash",
      error: timeoutExplanation,
      errorCode: "approval_timeout",
      timedOut: true,
    });
    expect(recordTrajectoryEvent).toHaveBeenCalledWith(
      "tool.result",
      expect.objectContaining({ output: timeoutExplanation, isError: true }),
    );
    await vi.waitFor(() =>
      expect(afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ error: timeoutExplanation }),
        expect.anything(),
      ),
    );
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
  });

  it("finalizes a native pre-tool failure when no item arrives", async () => {
    const runAbortController = new AbortController();
    const projector = await createProjector(undefined, {
      runAbortSignal: runAbortController.signal,
    });

    projector.recordNativeToolPreToolUseFailure({
      toolName: "exec",
      toolCallId: "native-no-item",
      disposition: "failed",
      durationMs: 5,
    });
    runAbortController.abort("codex_side_question_finished");
    projector.buildResult(buildEmptyToolTelemetry());
    projector.recordNativeToolPreToolUseFailure({
      toolName: "exec",
      toolCallId: "native-late-no-item",
      disposition: "failed",
      durationMs: 6,
    });
    await flushDiagnosticEvents();

    expect(
      diagnosticEvents.filter(
        (event) =>
          event.type.startsWith("tool.execution.") &&
          "toolCallId" in event &&
          (event.toolCallId === "native-no-item" || event.toolCallId === "native-late-no-item"),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "tool.execution.error",
        toolName: "exec",
        toolCallId: "native-no-item",
        durationMs: 5,
        errorCategory: "before_tool_call",
        terminalReason: "failed",
      }),
      expect.objectContaining({
        type: "tool.execution.error",
        toolName: "exec",
        toolCallId: "native-late-no-item",
        durationMs: 6,
        errorCategory: "before_tool_call",
        terminalReason: "cancelled",
      }),
    ]);
  });

  it("clears a declined pre-execution error after an unrelated action succeeds", async () => {
    const projector = await createProjector();

    await notify(projector, "item/completed", {
      item: { ...nativeCommand, id: "cmd-declined", status: "declined", durationMs: 1 },
    });
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual({
      toolName: "bash",
      meta: "run tests (workspace)",
      error: "codex native tool blocked",
      mutatingAction: false,
    });

    await notify(projector, "item/completed", {
      item: {
        ...nativeCommand,
        id: "cmd-recovered",
        command: "pnpm test src/foo.test.ts",
        status: "completed",
        aggregatedOutput: "ok",
        exitCode: 0,
        durationMs: 42,
      },
    });

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
  });
});

async function createObservedProjector(options?: Parameters<typeof createProjector>[1]) {
  const afterToolCall = vi.fn();
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
  );
  const projector = await createProjector(
    { ...(await createParams()), agentId: "main", sessionKey: "agent:main:session-1" },
    options,
  );
  return { afterToolCall, projector };
}

describe("CodexAppServerEventProjector native tool hook projection", () => {
  it("does not duplicate native items already covered by PostToolUse relay", async () => {
    const { afterToolCall, projector } = await createObservedProjector({
      nativePostToolUseRelayEnabled: true,
    });

    await notify(projector, "item/completed", {
      item: createNativeCommandItem({ id: "cmd-relayed", aggregatedOutput: "ok" }),
    });
    expect(afterToolCall).not.toHaveBeenCalled();

    await notify(projector, "item/completed", {
      item: {
        type: "webSearch",
        id: "search-observed",
        query: "",
        action: {
          type: "search",
          query: "native action query",
          queries: ["native action query", "secondary query"],
        },
        status: "completed",
        durationMs: 5,
      },
    });

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.toolName).toBe("web_search");
    expect(event.params).toEqual({
      query: "native action query",
      queries: ["native action query", "secondary query"],
    });
    expect(event.runId).toBe("run-1");
    expect(event.toolCallId).toBe("search-observed");
    expect(event.result).toEqual({
      status: "completed",
      durationMs: 5,
      query: "native action query",
      queries: ["native action query", "secondary query"],
    });
  });

  it("marks unavailable Codex web search queries explicitly", async () => {
    const { afterToolCall, projector } = await createObservedProjector();

    await notify(projector, "item/completed", {
      item: {
        type: "webSearch",
        id: "search-observed",
        query: "",
        action: { type: "other" },
        status: "completed",
      },
    });

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.params).toEqual({
      action: "other",
      queryUnavailable: true,
    });
    expect(event.result).toEqual({
      status: "completed",
      action: "other",
      queryUnavailable: true,
    });
  });
});
