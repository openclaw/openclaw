import { createContractToolTerminalObserver } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
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
  forCurrentTurn,
  readAttemptTerminal,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";
import { codexApprovalTimeoutText } from "./plugin-approval-roundtrip.js";

registerCodexEventProjectorTestLifecycle();

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
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: {
            ...nativeCommand,
            id: "cmd-declined",
            status: "inProgress",
            durationMs: null,
          },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            ...nativeCommand,
            id: "cmd-declined",
            status: "declined",
            durationMs: 1,
          },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const toolDiagnosticEvents = diagnosticEvents.filter(
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

  it("projects a cancelled native approval as one terminal error", async () => {
    const disposition = "cancelled";
    const projector = await createProjector();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: {
            ...nativeCommand,
            id: "cmd-approval-failure",
            status: "inProgress",
            durationMs: null,
          },
        }),
      );
      projector.recordNativeToolApprovalFailure("cmd-approval-failure", disposition);
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            ...nativeCommand,
            id: "cmd-approval-failure",
            status: "declined",
            durationMs: 1,
          },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    expect(
      diagnosticEvents
        .filter((event) => event.type.startsWith("tool.execution."))
        .map((event) =>
          "terminalReason" in event
            ? { type: event.type, terminalReason: event.terminalReason }
            : { type: event.type },
        ),
    ).toEqual([
      { type: "tool.execution.started" },
      { type: "tool.execution.error", terminalReason: disposition },
    ]);
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

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...item, status: "inProgress", durationMs: null },
      }),
    );
    projector.recordNativeToolApprovalFailure(item.id, "timed_out", "command");
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { ...item, status: "declined", durationMs: 1 },
      }),
    );

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

  it("coalesces a native pre-tool failure with the matching item terminal", async () => {
    const projector = await createProjector();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
    const item = {
      ...nativeCommand,
      id: "cmd-pre-tool-failure",
    };

    try {
      projector.recordNativeToolPreToolUseFailure({
        toolName: "exec",
        toolCallId: item.id,
        disposition: "timed_out",
        durationMs: 5,
      });
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { ...item, status: "inProgress", durationMs: null },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: { ...item, status: "declined", durationMs: 7 },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    expect(
      diagnosticEvents
        .filter(
          (event) =>
            event.type.startsWith("tool.execution.") &&
            "toolCallId" in event &&
            event.toolCallId === item.id,
        )
        .map((event) =>
          event.type === "tool.execution.error"
            ? {
                type: event.type,
                toolName: event.toolName,
                durationMs: event.durationMs,
                errorCategory: event.errorCategory,
                terminalReason: event.terminalReason,
              }
            : {
                type: event.type,
                toolName: "toolName" in event ? event.toolName : undefined,
              },
        ),
    ).toEqual([
      { type: "tool.execution.started", toolName: "bash" },
      {
        type: "tool.execution.error",
        toolName: "bash",
        durationMs: 7,
        errorCategory: "before_tool_call",
        terminalReason: "timed_out",
      },
    ]);
  });

  it("finalizes a native pre-tool failure when no item arrives", async () => {
    const runAbortController = new AbortController();
    const projector = await createProjector(undefined, {
      runAbortSignal: runAbortController.signal,
    });
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
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
    } finally {
      unsubscribe();
    }

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

  it.each([
    ["the same action recovers", nativeCommand.command],
    ["an unrelated action succeeds", "pnpm test src/foo.test.ts"],
  ])("clears a declined pre-execution error when %s", async (_scenario, command) => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { ...nativeCommand, id: "cmd-declined", status: "declined", durationMs: 1 },
      }),
    );
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual({
      toolName: "bash",
      meta: "run tests (workspace)",
      error: "codex native tool blocked",
      mutatingAction: false,
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          ...nativeCommand,
          id: "cmd-recovered",
          command,
          status: "completed",
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
  });

  it("preserves distinct native mutation failures when only one action recovers", async () => {
    const observeToolTerminal = vi.fn(
      createContractToolTerminalObserver("run-codex-native-failed"),
    );
    const projector = await createProjector({
      ...(await createParams()),
      observeToolTerminal,
    });
    const commandItem = (
      id: string,
      command: string,
      status: "completed" | "failed",
      output: string,
      exitCode: number,
    ) => ({
      ...nativeCommand,
      id,
      command,
      status,
      aggregatedOutput: output,
      exitCode,
      durationMs: 1,
    });
    const firstCommand = "node scripts/first.js --publish";
    const secondCommand = "node scripts/second.js --publish";

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: commandItem("cmd-first-failed", firstCommand, "failed", "first failed", 1),
      }),
    );
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toMatchObject({
      executionStarted: true,
    });
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: commandItem("cmd-second-failed", secondCommand, "failed", "second failed", 1),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: commandItem("cmd-second-recovered", secondCommand, "completed", "ok", 0),
      }),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: commandItem("cmd-first-recovered", firstCommand, "completed", "ok", 0),
      }),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
    expect(observeToolTerminal).toHaveBeenCalledTimes(4);
  });
});
