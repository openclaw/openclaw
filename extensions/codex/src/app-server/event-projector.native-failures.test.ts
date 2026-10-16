import { createContractToolTerminalObserver } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import * as h from "./event-projector.test-harness.js";
import { codexApprovalTimeoutText } from "./plugin-approval-roundtrip.js";

function notify(
  projector: Awaited<ReturnType<typeof h.createProjector>>,
  item: Record<string, unknown>,
) {
  return projector.handleNotification(
    h.forCurrentTurn(item.status === "inProgress" ? "item/started" : "item/completed", { item }),
  );
}

function commandEvent(
  projector: Awaited<ReturnType<typeof h.createProjector>>,
  id: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return notify(
    projector,
    createNativeCommandItem({
      id,
      status,
      exitCode: null,
      durationMs: status === "inProgress" ? null : 1,
      ...overrides,
    }),
  );
}

h.registerCodexEventProjectorTestLifecycle();

const diagnosticEvents: h.DiagnosticEventPayload[] = [];
let unsubscribeDiagnostics: (() => void) | undefined;
beforeEach(() => {
  diagnosticEvents.length = 0;
  unsubscribeDiagnostics = h.onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
});
afterEach(() => unsubscribeDiagnostics?.());

function diagnosticValues(...keys: string[]) {
  return diagnosticEvents
    .filter((event) => event.type.startsWith("tool.execution."))
    .map((event) => keys.map((key) => h.requireRecord(event, "tool diagnostic")[key]));
}

const blockedError = {
  toolName: "bash",
  meta: "run tests (workspace)",
  error: "codex native tool blocked",
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
      const projector = await h.createProjector(undefined, {
        trajectoryRecorder: { recordEvent, flush: vi.fn() },
      });
      const item = createNativeCommandItem({ id: "command-outcome", status, durationMs: 1 });
      await notify(projector, { ...item, status: "inProgress" });
      await notify(projector, item);

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
    const projector = await h.createProjector({
      ...(await h.createParams()),
      onAgentEvent,
      observeToolTerminal,
    });

    await commandEvent(projector, "cmd-declined", "inProgress");
    await commandEvent(projector, "cmd-declined", "declined");
    await h.flushDiagnosticEvents();

    expect(diagnosticValues("type", "toolName", "toolCallId")).toEqual([
      ["tool.execution.started", "bash", "cmd-declined"],
      ["tool.execution.blocked", "bash", "cmd-declined"],
    ]);
    expect(
      h.findAgentEvent(onAgentEvent, { stream: "item", phase: "end", itemId: "cmd-declined" }).data,
    ).toMatchObject({
      kind: "command",
      name: "bash",
      status: "blocked",
      suppressChannelProgress: true,
    });
    expect(
      h.findAgentEvent(onAgentEvent, {
        stream: "tool",
        phase: "result",
        itemId: "cmd-declined",
        name: "bash",
      }).data,
    ).toMatchObject({ toolCallId: "cmd-declined", status: "blocked", isError: true });
    expect(projector.buildResult(h.buildEmptyToolTelemetry()).lastToolError).toEqual({
      ...blockedError,
      executionStarted: false,
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
    h.initializeGlobalHookRunner(
      h.createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await h.createProjector(undefined, {
      trajectoryRecorder: { recordEvent: recordTrajectoryEvent, flush: vi.fn() },
    });
    const id = "cmd-approval-timeout";
    const timeoutExplanation = codexApprovalTimeoutText("command");

    await commandEvent(projector, id, "inProgress");
    projector.recordNativeToolApprovalFailure(id, "timed_out", "command");
    await commandEvent(projector, id, "declined");

    const result = projector.buildResult(h.buildEmptyToolTelemetry());
    const toolResult = result.messagesSnapshot.find(
      (message) => message.role === "toolResult" && message.toolCallId === id,
    );
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: id,
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
    expect(h.readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
  });

  it("finalizes a native pre-tool failure when no item arrives", async () => {
    const runAbortController = new AbortController();
    const projector = await h.createProjector(undefined, {
      runAbortSignal: runAbortController.signal,
    });

    const recordFailure = (toolCallId: string, durationMs: number) =>
      projector.recordNativeToolPreToolUseFailure({
        toolName: "exec",
        toolCallId,
        disposition: "failed",
        durationMs,
      });
    recordFailure("native-no-item", 5);
    runAbortController.abort("codex_side_question_finished");
    projector.buildResult(h.buildEmptyToolTelemetry());
    recordFailure("native-late-no-item", 6);
    await h.flushDiagnosticEvents();

    expect(
      diagnosticValues(
        "type",
        "toolName",
        "errorCategory",
        "toolCallId",
        "durationMs",
        "terminalReason",
      ),
    ).toEqual([
      ["tool.execution.error", "exec", "before_tool_call", "native-no-item", 5, "failed"],
      ["tool.execution.error", "exec", "before_tool_call", "native-late-no-item", 6, "cancelled"],
    ]);
  });

  it("clears a declined pre-execution error after an unrelated action succeeds", async () => {
    const projector = await h.createProjector();

    await commandEvent(projector, "cmd-declined", "declined");
    expect(projector.buildResult(h.buildEmptyToolTelemetry()).lastToolError).toEqual(blockedError);

    await commandEvent(projector, "cmd-recovered", "completed", {
      command: "pnpm test src/foo.test.ts",
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 42,
    });

    expect(projector.buildResult(h.buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
  });
});

async function createObservedProjector(options?: Parameters<typeof h.createProjector>[1]) {
  const afterToolCall = vi.fn();
  h.initializeGlobalHookRunner(
    h.createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
  );
  const projector = await h.createProjector(
    { ...(await h.createParams()), agentId: "main", sessionKey: "agent:main:session-1" },
    options,
  );
  return { afterToolCall, projector };
}

describe("CodexAppServerEventProjector native tool hook projection", () => {
  const query = {
    query: "native action query",
    queries: ["native action query", "secondary query"],
  };
  it.each([true, false])("projects web search with native relay=%s once", async (relay) => {
    const params = relay ? query : { action: "other", queryUnavailable: true };
    const timing = relay ? { durationMs: 5 } : {};
    const { afterToolCall, projector } = await createObservedProjector({
      nativePostToolUseRelayEnabled: relay,
    });
    if (relay) {
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
      action: relay ? { type: "search", ...query } : { type: "other" },
      status: "completed",
      ...timing,
    });
    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = h.requireRecord(h.mockCallArg(afterToolCall, 0, 0, "hook event"), "hook event");
    expect(event.params).toEqual(params);
    expect(event.result).toEqual({
      status: "completed",
      ...timing,
      ...params,
    });
    if (relay) {
      expect([event.toolName, event.runId, event.toolCallId]).toEqual([
        "web_search",
        "run-1",
        "search-observed",
      ]);
    }
  });
});
