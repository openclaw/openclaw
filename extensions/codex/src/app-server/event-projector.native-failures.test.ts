import {
  buildContractReplyPayloads,
  createContractToolTerminalObserver,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
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
  turnCompleted,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";
import { codexApprovalTimeoutText } from "./plugin-approval-roundtrip.js";

function notify(
  projector: Awaited<ReturnType<typeof createProjector>>,
  item: Record<string, unknown>,
  started = false,
) {
  return projector.handleNotification(
    forCurrentTurn(started ? "item/started" : "item/completed", { item }),
  );
}

registerCodexEventProjectorTestLifecycle();

const diagnosticEvents: DiagnosticEventPayload[] = [];
let unsubscribeDiagnostics: (() => void) | undefined;
beforeEach(() => {
  diagnosticEvents.length = 0;
  unsubscribeDiagnostics = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
});
afterEach(() => unsubscribeDiagnostics?.());

function command(id: string, status: string | undefined, durationMs: number | null = 1) {
  return { ...createNativeCommandItem({ id }), status, durationMs, exitCode: null };
}

it.each([
  { status: "completed", outcome: { status: "completed", isError: false, success: true } },
  { status: "failed", outcome: { status: "failed", isError: true, success: false } },
  { status: "declined", outcome: { status: "blocked", isError: true, success: false } },
  { status: "inProgress", outcome: { status: "running", isError: false } },
  { status: undefined, outcome: { status: "unknown", isError: false } },
  { status: "unrecognized", outcome: { status: "unknown", isError: false } },
])(
  "records the native $status outcome without treating running as success",
  async ({ status, outcome }) => {
    const recordEvent = vi.fn();
    const params = await createParams();
    params.observeToolTerminal = createContractToolTerminalObserver(params.runId);
    const projector = await createProjector(params, {
      trajectoryRecorder: { recordEvent, flush: vi.fn() },
    });
    if (status === "completed") {
      await notify(projector, command("prior", "declined"));
      recordEvent.mockClear();
    }
    const item = command("command-outcome", status);
    await notify(projector, { ...item, status: "inProgress" }, true);
    await notify(projector, item);

    const results = recordEvent.mock.calls.filter(([type]) => type === "tool.result");
    expect(results).toHaveLength(1);
    expect(results[0]?.[1]).toMatchObject({ toolCallId: item.id, name: "bash", ...outcome });
    if (!("success" in outcome)) {
      expect(results[0]?.[1]).not.toHaveProperty("success");
    }
    if (status === "completed") {
      expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
    }
  },
);

it("persists an approval timeout as failed tool evidence without aborting the turn", async () => {
  const afterToolCall = vi.fn();
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
  );
  const projector = await createProjector();
  const item = command("cmd-approval-timeout", undefined);
  const timeoutExplanation = codexApprovalTimeoutText("command");

  await notify(projector, { ...item, status: "inProgress", durationMs: null }, true);
  projector.recordNativeToolApprovalFailure(item.id, "timed_out", "command");
  await notify(projector, { ...item, status: "declined", durationMs: 1 });

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
      toolCallId: "native-no-item",
      terminalReason: "failed",
    }),
    expect.objectContaining({
      type: "tool.execution.error",
      toolCallId: "native-late-no-item",
      terminalReason: "cancelled",
    }),
  ]);
});

it.each([true, false])(
  "preserves an unanswered denial across a successful sibling (denialFirst=%s)",
  async (denialFirst) => {
    const params = await createParams();
    const observe = createContractToolTerminalObserver(params.runId);
    params.observeToolTerminal = observe;
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;
    const projector = await createProjector(params);
    await notify(projector, command("denied", "inProgress", null), true);
    projector.recordDynamicToolCall({
      callId: "sibling",
      tool: "read",
      arguments: { path: "README.md" },
    });
    const settleDenial = () => notify(projector, command("denied", "declined"));
    const settleRead = () =>
      projector.recordDynamicToolResult({
        callId: "sibling",
        tool: "read",
        success: true,
        terminalResolution: observe({
          toolCallId: "sibling",
          toolName: "read",
          arguments: { path: "README.md" },
          outcome: "success",
        }),
        contentItems: [{ type: "inputText", text: "File contents." }],
      });
    if (denialFirst) {
      await settleDenial();
      settleRead();
    } else {
      settleRead();
      await settleDenial();
    }
    await projector.handleNotification(turnCompleted());
    await flushDiagnosticEvents();
    expect(
      diagnosticEvents
        .filter(
          (event) =>
            event.type.startsWith("tool.execution.") &&
            "toolCallId" in event &&
            event.toolCallId === "denied",
        )
        .map(({ type }) => type),
    ).toEqual(["tool.execution.started", "tool.execution.blocked"]);
    expect(
      findAgentEvent(onAgentEvent, { stream: "item", phase: "end", itemId: "denied" }).data,
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
        itemId: "denied",
        name: "bash",
      }).data,
    ).toMatchObject({ toolCallId: "denied", status: "blocked", isError: true });
    const attempt = projector.buildResult(buildEmptyToolTelemetry());
    expect(attempt).toMatchObject({
      assistantTexts: [],
      lastToolError: {
        toolName: "bash",
        error: "codex native tool blocked",
        executionStarted: false,
        mutatingAction: false,
      },
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const results = [
      { toolCallId: "denied", isError: true },
      { toolCallId: "sibling", isError: false },
    ];
    expect(
      attempt.messagesSnapshot.filter((message) => message.role === "toolResult"),
    ).toMatchObject(denialFirst ? results : results.toReversed());
    expect(
      buildContractReplyPayloads({
        attempt,
        runParams: {
          sessionId: params.sessionId,
          runId: params.runId,
          workspaceDir: params.workspaceDir,
          prompt: params.prompt,
          timeoutMs: params.timeoutMs,
          config: params.config,
          provider: params.provider,
          model: params.modelId,
        },
      }),
    ).toEqual([{ text: "⚠️ Bash blocked", isError: true }]);
  },
);

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

async function observedHook(afterToolCall: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
  return requireRecord(
    mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
    "after_tool_call event",
  );
}

const query = {
  query: "native action query",
  queries: ["native action query", "secondary query"],
};
it.each([
  { kind: "search", action: { type: "search", ...query }, expected: query, durationMs: 5 },
  {
    kind: "other",
    action: { type: "other" },
    expected: { action: "other", queryUnavailable: true },
    durationMs: undefined,
  },
])(
  "projects $kind web-search evidence without duplicating native relay events",
  async ({ kind, action, expected, durationMs }) => {
    const { afterToolCall, projector } = await createObservedProjector(
      kind === "search" ? { nativePostToolUseRelayEnabled: true } : undefined,
    );
    if (kind === "search") {
      await notify(
        projector,
        createNativeCommandItem({ id: "cmd-relayed", aggregatedOutput: "ok" }),
      );
      expect(afterToolCall).not.toHaveBeenCalled();
    }
    await notify(projector, {
      type: "webSearch",
      id: "search-observed",
      query: "",
      action,
      status: "completed",
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    const event = await observedHook(afterToolCall);
    expect(event.params).toEqual(expected);
    expect(event.result).toEqual({
      status: "completed",
      ...(durationMs === undefined ? {} : { durationMs }),
      ...expected,
    });
    if (kind === "search") {
      expect(event).toMatchObject({
        toolName: "web_search",
        runId: "run-1",
        toolCallId: "search-observed",
      });
    }
  },
);
