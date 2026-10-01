import { afterEach, beforeEach } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  vi,
  TURN_ID,
  flushDiagnosticEvents,
  createParams,
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  readAttemptTerminal,
  findAgentEvent,
  forCurrentTurn,
  turnCompleted,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";

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

function expectUnknownOutcome(itemId: string) {
  expect(
    diagnosticEvents
      .filter((event) => "toolCallId" in event && event.toolCallId === itemId)
      .map((event) => ({
        type: event.type,
        terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
        errorCode: "errorCode" in event ? event.errorCode : undefined,
      })),
  ).toEqual([
    { type: "tool.execution.started", terminalReason: undefined, errorCode: undefined },
    { type: "tool.execution.error", terminalReason: "failed", errorCode: "tool_outcome_unknown" },
  ]);
}

describe("CodexAppServerEventProjector native tool finalization", () => {
  const mcpItem = {
    type: "mcpToolCall",
    id: "mcp-grant-item",
    server: "docs/raw-name",
    tool: "lookup.raw",
    arguments: { query: "exact argument", limit: 3 },
    status: "inProgress",
    appContext: null,
    pluginId: null,
    readOnlyHint: false,
    result: null,
    error: null,
    durationMs: null,
  };

  it("correlates only a unique active MCP item using raw server and tool identities", async () => {
    const projector = await createProjector();
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
    expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)).toBeUndefined();
    await notify(projector, "item/started", { item: mcpItem });
    await notify(projector, "item/started", {
      item: { ...mcpItem, id: "other-server-item", server: "other-server" },
    });
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toEqual({
      id: mcpItem.id,
      server: mcpItem.server,
      tool: mcpItem.tool,
      arguments: mcpItem.arguments,
    });
    expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)).toEqual({
      id: mcpItem.id,
      server: mcpItem.server,
      tool: mcpItem.tool,
      arguments: mcpItem.arguments,
      pluginId: null,
    });

    const concurrentItem = { ...mcpItem, id: "concurrent-item", pluginId: "external-plugin" };
    await notify(projector, "item/started", { item: concurrentItem });
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
    expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)).toBeUndefined();
    await notify(projector, "item/completed", { item: { ...concurrentItem, status: "completed" } });
    expect(projector.getActiveMcpToolCall(mcpItem.server)?.id).toBe(mcpItem.id);
    await notify(projector, "item/completed", { item: { ...mcpItem, status: "completed" } });
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
    expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)).toBeUndefined();
  });

  it("correlates a Codex app tool only by its exact connector and unique active item", async () => {
    const projector = await createProjector();
    const appItem = {
      ...mcpItem,
      server: "codex_apps",
      appContext: { connectorId: "connector_calendar", actionName: "lookup" },
    };
    await notify(projector, "item/started", { item: appItem });
    expect(projector.getActiveMcpToolCall("codex_apps")).toBeUndefined();
    expect(projector.getActiveMcpToolCallAttribution("codex_apps")).toBeUndefined();
    expect(projector.getActiveMcpToolCall("codex_apps", "connector_calendar")).toMatchObject({
      id: appItem.id,
      tool: appItem.tool,
      actionName: "lookup",
    });
    expect(projector.getActiveMcpToolCall("codex_apps", "connector_other")).toBeUndefined();

    const concurrent = {
      ...appItem,
      id: "other-app-item",
      appContext: { connectorId: "connector_other" },
    };
    await notify(projector, "item/started", { item: concurrent });
    expect(projector.getActiveMcpToolCall("codex_apps", "connector_calendar")?.id).toBe(appItem.id);
    await notify(projector, "item/started", {
      item: { ...appItem, id: "ambiguous-calendar-item" },
    });
    expect(projector.getActiveMcpToolCall("codex_apps", "connector_calendar")).toBeUndefined();
  });

  it("exposes only the unique active MCP item's trusted plugin attribution", async () => {
    const projector = await createProjector();
    const pluginItem = { ...mcpItem, pluginId: "calendar@openai-curated" };
    const started = forCurrentTurn("item/started", { item: pluginItem });
    projector.recordMcpToolCallReceipt(started);
    expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)).toBeUndefined();
    await projector.handleNotification(started);

    expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)).toEqual({
      id: pluginItem.id,
      server: pluginItem.server,
      tool: pluginItem.tool,
      arguments: pluginItem.arguments,
      pluginId: pluginItem.pluginId,
    });

    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();

    const configuredServerItem = { ...mcpItem, id: "configured-server-item" };
    await notify(projector, "item/started", { item: configuredServerItem });
    expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)).toBeUndefined();
    await notify(projector, "item/completed", {
      item: { ...configuredServerItem, status: "completed" },
    });
    expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)?.pluginId).toBe(
      pluginItem.pluginId,
    );
  });

  it.each([
    { label: "missing", pluginId: undefined },
    { label: "blank", pluginId: " " },
  ])("does not attest an MCP item with a $label plugin ID", async ({ pluginId }) => {
    const projector = await createProjector();
    await notify(projector, "item/started", { item: { ...mcpItem, pluginId } });
    expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)).toBeUndefined();
  });

  it.each(["receipt", "projection"] as const)(
    "preserves active MCP correlation after a nonterminal completion at %s",
    async (phase) => {
      const projector = await createProjector();
      await notify(projector, "item/started", { item: mcpItem });
      const activeCall = {
        id: mcpItem.id,
        server: mcpItem.server,
        tool: mcpItem.tool,
        arguments: mcpItem.arguments,
      };
      expect(projector.getActiveMcpToolCall(mcpItem.server)).toEqual(activeCall);

      const invalid = forCurrentTurn("turn/completed", {
        turn: { id: TURN_ID, status: "inProgress", items: [] },
      });
      if (phase === "receipt") {
        projector.recordMcpToolCallReceipt(invalid);
      } else {
        await projector.handleNotification(invalid);
      }
      expect(projector.getActiveMcpToolCall(mcpItem.server)).toEqual(activeCall);
      expect(projector.getCompletedTurnStatus()).toBeUndefined();

      const completed = turnCompleted();
      if (phase === "receipt") {
        projector.recordMcpToolCallReceipt(completed);
      } else {
        await projector.handleNotification(completed);
      }
      expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
    },
  );

  it.each([
    { label: "another thread", params: { threadId: "other-thread" } },
    { label: "another turn", params: { turnId: "other-turn" } },
    { label: "completed status", item: { status: "completed" } },
    { label: "missing raw arguments", item: { arguments: undefined } },
    { label: "blank raw tool", item: { tool: " " } },
    { label: "missing tool", item: { tool: undefined } },
    { label: "app context", item: { appContext: { resourceUri: "ui://app/view" } } },
    { label: "plugin context", item: { pluginId: "external-plugin" } },
  ])("does not correlate an MCP item from $label", async (testCase) => {
    const projector = await createProjector();
    await notify(projector, "item/started", {
      ...("params" in testCase ? testCase.params : {}),
      item: { ...mcpItem, ...("item" in testCase ? testCase.item : {}) },
    });
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
  });

  it.each(["closed", "finalized", "timed out"])(
    "does not correlate MCP items after the turn is %s",
    async (ending) => {
      const projector = await createProjector();
      await notify(projector, "item/started", { item: mcpItem });
      if (ending === "closed") {
        await projector.closeProjection();
      } else if (ending === "finalized") {
        projector.buildResult(buildEmptyToolTelemetry());
      } else {
        projector.markTimedOut();
      }
      await notify(projector, "item/started", { item: { ...mcpItem, id: "late-item" } });
      expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
      expect(projector.getActiveMcpToolCallAttribution(mcpItem.server)).toBeUndefined();
    },
  );

  it("marks only explicitly completed native tool metadata with false", async () => {
    const projector = await createProjector();
    const command = {
      type: "commandExecution",
      command: "pnpm test extensions/codex",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };

    await notify(projector, "item/started", {
      item: { ...command, id: "cmd-started-only", status: "inProgress" },
    });
    await notify(projector, "item/completed", {
      item: { ...command, id: "cmd-completed", status: "completed" },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMetas.map((meta) => meta.isError)).toEqual([undefined, false]);
  });

  it("keeps raw open-page status unknown until explicit completion", async () => {
    const projector = await createProjector();
    const item = {
      id: "web-search-open-page-1",
      type: "webSearch",
      query: "",
      action: { type: "openPage", url: "https://example.com/sensitive" },
    };

    await notify(projector, "item/started", { item });
    await notify(projector, "item/completed", { item });
    await notify(projector, "rawResponseItem/completed", {
      item: {
        id: item.id,
        type: "web_search_call",
        status: "open",
        action: { type: "open_page", url: "https://example.com/sensitive" },
      },
    });
    await flushDiagnosticEvents();

    expectUnknownOutcome(item.id);
    expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
  });

  it("keeps native web-search outcomes unknown at finalization when no raw terminal arrives", async () => {
    const abortController = new AbortController();
    abortController.abort("cancelled");
    const projector = await createProjector(undefined, {
      runAbortSignal: abortController.signal,
    });
    const item = {
      id: "web-search-without-raw-terminal",
      type: "webSearch",
      query: "sensitive extension query",
      action: { type: "search", query: "sensitive extension query", queries: null },
    };

    await notify(projector, "item/started", { item });
    await notify(projector, "item/completed", { item });
    projector.buildResult(buildEmptyToolTelemetry());
    await flushDiagnosticEvents();

    expectUnknownOutcome(item.id);
    expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive extension query");
  });

  it("keeps started-only image-generation outcome unknown when the run times out", async () => {
    const abortController = new AbortController();
    abortController.abort(Object.assign(new Error("turn timed out"), { name: "TimeoutError" }));
    const projector = await createProjector(undefined, { runAbortSignal: abortController.signal });
    const item = {
      id: "image-generation-started-only",
      type: "imageGeneration",
      status: "in_progress",
      revisedPrompt: "sensitive prompt",
      result: null,
    };
    await notify(projector, "item/started", { item });
    projector.buildResult(buildEmptyToolTelemetry());
    await flushDiagnosticEvents();
    expectUnknownOutcome(item.id);
    expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
  });

  it("keeps missing native image-generation terminal status non-successful", async () => {
    const projector = await createProjector();
    const item = {
      id: "image-generation-missing",
      type: "imageGeneration",
      revisedPrompt: null,
      result: null,
    };
    await notify(projector, "item/started", { item: { ...item, status: "in_progress" } });
    await notify(projector, "item/completed", { item });
    await flushDiagnosticEvents();
    expectUnknownOutcome(item.id);
  });

  it("synthesizes native tool progress from turn completion snapshots", async () => {
    const largeOutput = "a".repeat(9886) + "😀" + "a".repeat(2457);
    const onAgentEvent = vi.fn();
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const onToolResult = vi.fn();
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(
      {
        ...(await createParams()),
        agentId: "main",
        sessionKey: "agent:main:session-1",
        verboseLevel: "on",
        onAgentEvent,
        onToolResult,
      },
      {
        trajectoryRecorder,
      },
    );

    await projector.handleNotification(
      turnCompleted([
        createNativeCommandItem({
          id: "cmd-snapshot",
          aggregatedOutput: largeOutput,
        }),
      ]),
    );

    const toolStart = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "start",
      itemId: "cmd-snapshot",
      name: "bash",
    }).data;
    expect(toolStart.args).toEqual({ command: "pnpm test extensions/codex", cwd: "/workspace" });
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-snapshot",
      name: "bash",
    }).data;
    expect(toolResult.status).toBe("completed");
    expect(toolResult.isError).toBe(false);
    expect(onToolResult).toHaveBeenCalledWith({
      text: "🛠️ Bash",
    });
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "tool.call",
      expect.objectContaining({
        toolCallId: "cmd-snapshot",
        name: "bash",
        arguments: { command: "pnpm test extensions/codex", cwd: "/workspace" },
      }),
    );
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "tool.result",
      expect.objectContaining({
        toolCallId: "cmd-snapshot",
        name: "bash",
        status: "completed",
        isError: false,
        result: { status: "completed", exitCode: 0, durationMs: 42 },
        output: expect.stringContaining("OpenClaw truncated Codex native tool output"),
      }),
    );
    const trajectoryOutput = trajectoryRecorder.recordEvent.mock.calls.find(
      ([type]) => type === "tool.result",
    )?.[1];
    expect(requireRecord(trajectoryOutput, "trajectory result").output).toHaveLength(9_999);
    expect(requireRecord(trajectoryOutput, "trajectory result").output).toContain(
      "original 12345 chars",
    );
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.messagesSnapshot).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "cmd-snapshot",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: largeOutput }],
      }),
    );
    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    expect(afterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "bash",
        toolCallId: "cmd-snapshot",
        runId: "run-1",
        params: { command: "pnpm test extensions/codex", cwd: "/workspace" },
        result: { status: "completed", exitCode: 0, durationMs: 42 },
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-snapshot",
      }),
    );
    expect(
      requireRecord(afterToolCall.mock.calls[0]?.[0], "native hook").durationMs,
    ).toBeGreaterThanOrEqual(42);
  });

  it("delivers completed assistant text when a native tool call finishes without a matching result", async () => {
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(await createParams(), { trajectoryRecorder });

    await notify(projector, "item/started", {
      item: createNativeCommandItem({
        id: "cmd-denied",
        command: "node scripts/report.js --publish",
        status: "inProgress",
        exitCode: null,
        durationMs: null,
      }),
    });
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-denied",
          text: "The requested publish command was denied before execution.",
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(readAttemptTerminal(result).promptErrorSource).toBeNull();
    expect(result.lastToolError).toBeUndefined();
    expect(result.assistantTexts).toEqual([
      "The requested publish command was denied before execution.",
    ]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage.toolCallId).toBe("cmd-denied");
    expect(toolResultMessage.toolName).toBe("bash");
    expect(toolResultMessage.isError).toBe(true);
    expect(toolResultMessage.details).toEqual({ reason: "missing_tool_result" });
    expect(toolResultMessage.content).toEqual([
      { type: "text", text: expect.stringContaining("matching tool.result") },
    ]);
    const finalAssistant = requireRecord(result.messagesSnapshot[3], "final assistant message");
    expect(finalAssistant.content).toEqual([
      {
        type: "text",
        text: "The requested publish command was denied before execution.",
      },
    ]);
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "tool.result",
      expect.objectContaining({
        toolCallId: "cmd-denied",
        name: "bash",
        status: "failed",
        isError: true,
        result: { status: "failed", reason: "missing_tool_result" },
        output: expect.stringContaining("without a matching tool.result"),
      }),
    );
  });

  it("records promptError when a completed turn has only whitespace assistant text and an orphan tool call", async () => {
    const projector = await createProjector(await createParams());

    await notify(projector, "item/started", {
      item: createNativeCommandItem({
        id: "cmd-whitespace",
        status: "inProgress",
        exitCode: null,
        durationMs: null,
      }),
    });
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-whitespace",
          text: "   \n\t  ",
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(readAttemptTerminal(result).promptError).toContain("without a matching tool.result");
    expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
    expect(result.lastToolError).toBeUndefined();
    expect(result.assistantTexts).toEqual([]);
  });
});
