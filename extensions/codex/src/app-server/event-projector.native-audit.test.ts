import { afterEach, beforeEach } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  flushDiagnosticEvents,
  createProjector,
  createParams,
  path,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  forCurrentTurn,
  type DiagnosticEventPayload,
  vi,
  TURN_ID,
  readAttemptTerminal,
  turnCompleted,
} from "./event-projector.test-harness.js";
import {
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";

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

describe("CodexAppServerEventProjector native tool audit projection", () => {
  const workspaceRejection = {
    status: "declined",
    output: "patch rejected: writing outside of the project; rejected by user approval settings",
    outputFirst: true,
    isError: true,
  };

  it("preserves structured file-change diffs in mirrored transcript calls", async () => {
    const projector = await createProjector();
    const changes = [
      {
        path: "src/updated.ts",
        kind: { type: "update", move_path: null },
        diff: [
          "--- a/src/updated.ts",
          "+++ b/src/updated.ts",
          "@@ -1 +1,2 @@",
          "-old",
          "+new",
          "+another",
          "",
        ].join("\n"),
      },
      {
        path: "src/created.ts",
        kind: { type: "add" },
        diff: "first\nsecond\n",
      },
      {
        path: "src/deleted.ts",
        kind: { type: "delete" },
        diff: "removed\n",
      },
    ];

    await notify(projector, "item/completed", {
      item: {
        type: "fileChange",
        id: "patch-structured",
        changes,
        status: "completed",
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    const assistantContent = requireArray(assistant.content, "assistant content");
    const toolCall = requireRecord(assistantContent[0], "file-change tool call");
    const expectedChanges = [
      { ...changes[0], stat: { added: 2, removed: 1 } },
      { ...changes[1], stat: { added: 2, removed: 0 } },
      { ...changes[2], stat: { added: 0, removed: 1 } },
    ];
    expect(toolCall.name).toBe("apply_patch");
    expect(toolCall.arguments).toEqual({ changes: expectedChanges });
  });

  it.each([
    {
      label: "successful patch output after its native item",
      status: "completed",
      output: "Successfully applied patch to runtime-tool-fixture-patch.txt",
      outputFirst: false,
      isError: false,
    },
    {
      label: "JSON-function workspace rejection without a native FileChange item",
      ...workspaceRejection,
      functionCall: true,
      omitNativeItem: true,
    },
    {
      label: "intercepted exec-command workspace rejection without a native FileChange item",
      ...workspaceRejection,
      functionCall: true,
      execCommand: true,
      omitNativeItem: true,
    },
    {
      label:
        "intercepted cd-prefixed exec-command workspace rejection without a native FileChange item",
      ...workspaceRejection,
      functionCall: true,
      execCommand: true,
      workingDirectoryPrefix: true,
      omitNativeItem: true,
    },
    {
      label: "code-mode static template input and bound result with automatic semicolons",
      ...workspaceRejection,
      codeMode: (input: string) =>
        `// @exec: {}\nconst patch = \`${input}\`\nconst result = await tools.apply_patch(patch)\ntext(result)`,
      omitNativeItem: true,
    },
  ])("persists the linked Codex raw $label", async (testCase) => {
    const params = await createParams();
    await attachSqliteSessionTarget(
      params,
      path.join(params.workspaceDir, "sessions.json"),
      "patch",
    );
    const projector = await createProjector(params);
    const callId = "native-patch-raw-result";
    const patchInput =
      "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n+*** End Patch\n*** End Patch\n";

    await notify(projector, "rawResponseItem/completed", {
      item: {
        type: "functionCall" in testCase ? "function_call" : "custom_tool_call",
        call_id: callId,
        name:
          "codeMode" in testCase
            ? "exec"
            : "execCommand" in testCase
              ? "exec_command"
              : "apply_patch",
        ...("functionCall" in testCase
          ? {
              arguments: JSON.stringify(
                "execCommand" in testCase
                  ? {
                      cmd: `${"workingDirectoryPrefix" in testCase ? "cd /workspace && " : ""}apply_patch <<'PATCH'\n${patchInput}PATCH\n`,
                      ...("executionWorkdir" in testCase
                        ? { workdir: testCase.executionWorkdir }
                        : {}),
                    }
                  : { input: patchInput },
              ),
            }
          : {
              input: "codeMode" in testCase ? testCase.codeMode(patchInput) : patchInput,
            }),
      },
    });

    const completed = forCurrentTurn("item/completed", {
      item: {
        type: "fileChange",
        id: callId,
        changes: [{ path: "runtime-tool-fixture-patch.txt", kind: { type: "add" } }],
        status: testCase.status,
      },
    });
    const rawOutput = forCurrentTurn("rawResponseItem/completed", {
      item: {
        type: "functionCall" in testCase ? "function_call_output" : "custom_tool_call_output",
        call_id: callId,
        output:
          "codeMode" in testCase
            ? [
                {
                  type: "input_text",
                  text: `Script ${testCase.isError ? "failed" : "completed"}\nWall time 6.0 seconds\nOutput:\n`,
                },
                {
                  type: "input_text",
                  text: testCase.isError ? `Script error:\n${testCase.output}` : testCase.output,
                },
              ]
            : testCase.output,
      },
    });
    const notifications =
      "omitNativeItem" in testCase
        ? [rawOutput]
        : testCase.outputFirst
          ? [rawOutput, completed]
          : [completed, rawOutput];
    for (const notification of notifications) {
      await projector.handleNotification(notification);
    }

    const messages = await readTranscriptMessagesByIdentity(params);
    const assistant = requireRecord(messages[0], "native patch call");
    const call = requireRecord(requireArray(assistant.content, "native patch content")[0], "call");
    expect(call).toMatchObject({
      type: "toolCall",
      id: callId,
      name: "apply_patch",
      arguments: {
        input: patchInput,
        ...("workingDirectoryPrefix" in testCase
          ? { cwd: "/workspace" }
          : "executionWorkdir" in testCase
            ? { cwd: testCase.executionWorkdir }
            : {}),
      },
    });
    expect(projector.buildResult(buildEmptyToolTelemetry()).toolMetas).toEqual([
      expect.objectContaining({ toolName: "apply_patch", isError: testCase.isError }),
    ]);
    const toolResult = requireRecord(messages[1], "native patch result");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: callId,
      toolName: "apply_patch",
      isError: testCase.isError,
    });
    const output = requireRecord(
      requireArray(toolResult.content, "native patch result")[0],
      "result",
    );
    expect(output.text).toBe(
      "codeMode" in testCase
        ? JSON.stringify((rawOutput.params as { item: { output: unknown } }).item.output, null, 2)
        : testCase.output,
    );
  });

  it.each(["direct rejection", "code-mode nonzero exit", "code-mode input object"])(
    "mirrors raw command %s without a commandExecution item",
    async (mode) => {
      const params = await createParams();
      await attachSqliteSessionTarget(
        params,
        path.join(params.workspaceDir, "sessions.json"),
        "command",
      );
      const projector = await createProjector(params);
      const callId = "native-exec-workspace-rejection";
      const args = {
        cmd: `node -e "require('node:fs').writeFileSync('../denied.txt', 'must not change')"`,
        workdir: "/workspace",
      };
      const rejection =
        "command rejected: writing outside of the project; rejected by user approval settings";
      const output =
        mode === "direct rejection"
          ? rejection
          : [
              {
                type: "input_text",
                text: `Script ${mode === "code-mode rejection" ? "failed" : "completed"}\nWall time 0.1 seconds\nOutput:\n`,
              },
              {
                type: "input_text",
                text:
                  mode === "code-mode rejection"
                    ? `Script error:\n${rejection}`
                    : JSON.stringify({
                        chunk_id: "denied",
                        wall_time_seconds: 0.1,
                        exit_code: 1,
                        output: "Error: EPERM: operation not permitted, open '../denied.txt'",
                      }),
              },
            ];

      await notify(projector, "rawResponseItem/completed", {
        item: {
          type: mode === "direct rejection" ? "function_call" : "custom_tool_call",
          call_id: callId,
          name: mode === "direct rejection" ? "exec_command" : "exec",
          ...(mode === "direct rejection"
            ? { arguments: JSON.stringify(args) }
            : {
                input:
                  mode === "code-mode input object"
                    ? `const args = {cmd: ${JSON.stringify(args.cmd)}, workdir: '/workspace', yield_time_ms: 1000}; text(await tools.exec_command(args));`
                    : `const result = await tools.exec_command(${JSON.stringify(args)}); text(result);`,
              }),
        },
      });
      await notify(projector, "rawResponseItem/completed", {
        item: {
          type: mode === "direct rejection" ? "function_call_output" : "custom_tool_call_output",
          call_id: callId,
          output,
        },
      });

      const messages = await readTranscriptMessagesByIdentity(params);
      const assistant = requireRecord(messages[0], "native exec call");
      const call = requireRecord(requireArray(assistant.content, "native exec content")[0], "call");
      expect(call).toMatchObject({
        type: "toolCall",
        id: callId,
        name: "bash",
      });
      expect(call.arguments).toEqual({ command: args.cmd, cwd: args.workdir });
      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.toolMetas).toEqual([
        expect.objectContaining({ toolName: "bash", isError: true }),
      ]);
      expect(result.replayMetadata).toMatchObject({
        hadPotentialSideEffects: mode !== "direct rejection",
        replaySafe: mode === "direct rejection",
      });
      const toolResult = requireRecord(messages[1], "native exec result");
      expect(toolResult).toMatchObject({
        role: "toolResult",
        toolCallId: callId,
        toolName: "bash",
        isError: true,
        content: [
          {
            type: "text",
            text: typeof output === "string" ? output : JSON.stringify(output, null, 2),
          },
        ],
      });
    },
  );

  it.each([
    {
      label: "patch text quoted inside a shell heredoc",
      command:
        "cat <<'TEXT'\napply_patch is documented below\n*** Begin Patch\n*** Add File: fake.txt\n+not a patch invocation\n*** End Patch\nTEXT\n",
    },
  ])("does not mistake $label for a native patch", async ({ command }) => {
    const projector = await createProjector();
    const callId = "not-a-native-patch";

    await notify(projector, "rawResponseItem/completed", {
      item: {
        type: "function_call",
        call_id: callId,
        name: "exec_command",
        arguments: JSON.stringify({ cmd: command }),
      },
    });
    await notify(projector, "rawResponseItem/completed", {
      item: {
        type: "function_call_output",
        call_id: callId,
        output:
          "patch rejected: writing outside of the project; rejected by user approval settings",
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(
      result.messagesSnapshot.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolCallId === callId &&
          message.toolName === "apply_patch",
      ),
    ).toBe(false);
  });

  it("bounds mirrored file-change diffs without losing full stats", async () => {
    const diff = [
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -1 +1,200 @@",
      "-old",
      ...Array.from({ length: 200 }, (_, index) => `+${index}-${"x".repeat(96)}`),
      "",
    ].join("\n");
    const projector = await createProjector();

    await notify(projector, "item/completed", {
      item: {
        type: "fileChange",
        id: "patch-large",
        changes: [{ path: "src/large.ts", kind: { type: "update" }, diff }],
        status: "completed",
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    const assistantContent = requireArray(assistant.content, "assistant content");
    const toolCall = requireRecord(assistantContent[0], "file-change tool call");
    const args = requireRecord(toolCall.arguments, "file-change arguments");
    const projectedChanges = requireArray(args.changes, "projected file changes");
    const projectedChange = requireRecord(projectedChanges[0], "projected file change");
    const projectedDiff = projectedChange.diff;
    expect(typeof projectedDiff).toBe("string");
    if (typeof projectedDiff !== "string") {
      throw new Error("Expected bounded file-change diff");
    }
    expect(projectedDiff.length).toBeLessThanOrEqual(12_000);
    expect(projectedDiff.endsWith("\n")).toBe(true);
    expect(diff.startsWith(projectedDiff)).toBe(true);
    expect(projectedChange.diffTruncated).toBe(true);
    expect(projectedChange.stat).toEqual({ added: 200, removed: 1 });
  });

  it.each([
    [Object.assign(new Error("turn timed out"), { name: "TimeoutError" }), "timed_out"],
  ] as const)(
    "preserves enclosing %s provenance for failed native tools",
    async (abortReason, terminalReason) => {
      const abortController = new AbortController();
      abortController.abort(abortReason);
      const projector = await createProjector(undefined, {
        runAbortSignal: abortController.signal,
      });
      const commandItem = createNativeCommandItem({
        id: "cmd-aborted",
        status: "inProgress",
        exitCode: null,
        durationMs: null,
      });

      await notify(projector, "item/started", { item: commandItem });
      await notify(projector, "item/completed", {
        item: { ...commandItem, status: "failed", durationMs: 4 },
      });
      await flushDiagnosticEvents();

      expect(diagnosticEvents).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "cmd-aborted",
          terminalReason,
        }),
      );
    },
  );

  it.each([
    ["completed", "tool.execution.completed", undefined, undefined],
    ["failed", "tool.execution.error", "failed", undefined],
    ["cancelled", "tool.execution.error", "cancelled", undefined],
  ] as const)(
    "uses raw %s status for redacted native web-search audit actions",
    async (status, terminalType, terminalReason, errorCode) => {
      const projector = await createProjector();
      const item = {
        id: "web-search-audit-1",
        type: "webSearch",
        query: "sensitive query",
        action: { type: "search", query: "sensitive query", queries: null },
      };

      await notify(projector, "item/started", { item, startedAtMs: 1_750_000_000_000 });
      await notify(projector, "item/completed", { item, completedAtMs: 1_750_000_000_042 });
      await notify(projector, "rawResponseItem/completed", {
        item: {
          id: item.id,
          type: "web_search_call",
          status,
          action: item.action,
        },
      });
      await flushDiagnosticEvents();

      expect(
        diagnosticEvents
          .filter((event) => "toolCallId" in event && event.toolCallId === item.id)
          .map((event) => ({
            type: event.type,
            toolName: "toolName" in event ? event.toolName : null,
            terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
            errorCode: "errorCode" in event ? event.errorCode : undefined,
            sourceTimestampMs: "sourceTimestampMs" in event ? event.sourceTimestampMs : undefined,
          })),
      ).toEqual([
        {
          type: "tool.execution.started",
          toolName: "web_search",
          terminalReason: undefined,
          errorCode: undefined,
          sourceTimestampMs: 1_750_000_000_000,
        },
        {
          type: terminalType,
          toolName: "web_search",
          terminalReason,
          errorCode,
          sourceTimestampMs: 1_750_000_000_042,
        },
      ]);
      expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
    },
  );
});

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

    const concurrentItem = { ...mcpItem, id: "concurrent-item", pluginId: "external-plugin" };
    await notify(projector, "item/started", { item: concurrentItem });
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
    await notify(projector, "item/completed", { item: { ...concurrentItem, status: "completed" } });
    expect(projector.getActiveMcpToolCall(mcpItem.server)?.id).toBe(mcpItem.id);
    await notify(projector, "item/completed", { item: { ...mcpItem, status: "completed" } });
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
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
    },
  );

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
});
