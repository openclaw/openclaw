import {
  buildContractReplyPayloads,
  createContractToolTerminalObserver,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
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
  turnCompleted,
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

function command(id: string, status: string | undefined, durationMs: number | null = 1) {
  return { ...createNativeCommandItem({ id }), status, durationMs, exitCode: null };
}

const blockedError = {
  toolName: "bash",
  meta: "run tests (workspace)",
  error: "codex native tool blocked",
  executionStarted: false,
  mutatingAction: false,
};

describe("CodexAppServerEventProjector native tool failure recovery", () => {
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
      const projector = await createProjector(undefined, {
        trajectoryRecorder: { recordEvent, flush: vi.fn() },
      });
      const item = command("command-outcome", status);
      await notify(projector, "item/started", {
        item: { ...item, status: "inProgress" },
      });
      await notify(projector, "item/completed", { item });

      const results = recordEvent.mock.calls.filter(([type]) => type === "tool.result");
      expect(results).toHaveLength(1);
      expect(results[0]?.[1]).toMatchObject({ toolCallId: item.id, name: "bash", ...outcome });
      if (!("success" in outcome)) {
        expect(results[0]?.[1]).not.toHaveProperty("success");
      }
    },
  );

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
      item: command("cmd-declined", "inProgress", null),
    });
    await notify(projector, "item/completed", {
      item: command("cmd-declined", "declined"),
    });
    await flushDiagnosticEvents();

    const toolDiagnosticEvents = diagnosticEvents.filter(
      (event): event is Extract<DiagnosticEventPayload, { type: `tool.execution.${string}` }> =>
        event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map(({ type, toolName, toolCallId }) => [type, toolName, toolCallId]),
    ).toEqual([
      ["tool.execution.started", "bash", "cmd-declined"],
      ["tool.execution.blocked", "bash", "cmd-declined"],
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
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual(blockedError);
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
    const item = command("cmd-approval-timeout", undefined);
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

  it.each([true, false])(
    "preserves an unanswered denial across a successful sibling (denialFirst=%s)",
    async (denialFirst) => {
      const params = await createParams();
      const observe = createContractToolTerminalObserver(params.runId);
      params.observeToolTerminal = observe;
      const projector = await createProjector(params);
      await notify(projector, "item/started", {
        item: command("denied", "inProgress", null),
      });
      projector.recordDynamicToolCall({
        callId: "sibling",
        tool: "read",
        arguments: { path: "README.md" },
      });
      const settleDenial = () =>
        notify(projector, "item/completed", {
          item: command("denied", "declined"),
        });
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
      const attempt = projector.buildResult(buildEmptyToolTelemetry());
      expect(attempt).toMatchObject({
        assistantTexts: [],
        currentAttemptAssistant: undefined,
        agentHarnessResultClassification: "empty",
        lastToolError: {
          toolName: "bash",
          error: "codex native tool blocked",
          executionStarted: false,
          mutatingAction: false,
        },
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      });
      expect(attempt.toolMetas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName: "bash", isError: true }),
          expect.objectContaining({ toolName: "read", isError: false }),
        ]),
      );
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

  it("clears a declined pre-execution error after the same tool succeeds", async () => {
    const params = await createParams();
    params.observeToolTerminal = createContractToolTerminalObserver(params.runId);
    const projector = await createProjector(params);

    await notify(projector, "item/completed", {
      item: command("cmd-declined", "declined"),
    });
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual(blockedError);

    await notify(projector, "item/completed", {
      item: {
        ...command("cmd-recovered", "completed", 42),
        command: "pnpm test src/foo.test.ts",
        aggregatedOutput: "ok",
        exitCode: 0,
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

async function observedHook(afterToolCall: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
  return requireRecord(
    mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
    "after_tool_call event",
  );
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

    const query = {
      query: "native action query",
      queries: ["native action query", "secondary query"],
    };
    await notify(projector, "item/completed", {
      item: {
        type: "webSearch",
        id: "search-observed",
        query: "",
        action: { type: "search", ...query },
        status: "completed",
        durationMs: 5,
      },
    });

    const { toolName, params, runId, toolCallId, result } = await observedHook(afterToolCall);
    expect({ toolName, params, runId, toolCallId, result }).toEqual({
      toolName: "web_search",
      params: query,
      runId: "run-1",
      toolCallId: "search-observed",
      result: { status: "completed", durationMs: 5, ...query },
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

    const event = await observedHook(afterToolCall);
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
