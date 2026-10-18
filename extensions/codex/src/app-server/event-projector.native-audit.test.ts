import { afterEach, beforeEach } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  createConfiguredProjection,
  createProjection,
} from "./event-projector-projection.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  flushDiagnosticEvents,
  createParams,
  path,
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

function firstContent(message: unknown) {
  return requireRecord(
    requireArray(requireRecord(message, "assistant").content, "content")[0],
    "tool call",
  );
}

async function persistedProjector(key: string) {
  const params = await createParams();
  await attachSqliteSessionTarget(params, path.join(params.workspaceDir, "sessions.json"), key);
  return { params, ...(await createProjection(params)) };
}

function rawCall(
  callId: string,
  name: string,
  input: string | Record<string, unknown>,
  custom = false,
) {
  return {
    type: custom ? "custom_tool_call" : "function_call",
    call_id: callId,
    name,
    ...(custom ? { input } : { arguments: JSON.stringify(input) }),
  };
}
function rawOutput(callId: string, output: unknown, custom = false) {
  return {
    type: custom ? "custom_tool_call_output" : "function_call_output",
    call_id: callId,
    output,
  };
}
function fileChange(id: string, changes: unknown[], status = "completed") {
  return { type: "fileChange", id, changes, status };
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
  it.each([
    ["function_call", "function_call_output"],
    ["custom_tool_call", "custom_tool_call_output"],
    ["local_shell_call", "function_call_output"],
    ["tool_search_call", "tool_search_output"],
  ])("projects the raw %s lifecycle without its payload", async (callType, outputType) => {
    const onAgentEvent = vi.fn();
    const { events } = await createConfiguredProjection({ onAgentEvent });
    await events.raw({
      type: callType,
      call_id: "outer-call",
      name: "exec",
      input: "private code",
    });
    await events.raw({ type: outputType, call_id: "outer-call", output: "private result" });
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "codex_app_server.item"),
    ).toEqual([
      {
        stream: "codex_app_server.item",
        data: { phase: "started", itemId: "outer-call", type: callType },
      },
      {
        stream: "codex_app_server.item",
        data: { phase: "completed", itemId: "outer-call", type: outputType },
      },
    ]);
  });

  const workspaceRejection =
    "patch rejected: writing outside of the project; rejected by user approval settings";

  it("preserves structured file-change diffs in mirrored transcript calls", async () => {
    const { events } = await createProjection();
    const changes = [
      {
        path: "src/updated.ts",
        kind: { type: "update", move_path: null },
        diff: "--- a/src/updated.ts\n+++ b/src/updated.ts\n@@ -1 +1,2 @@\n-old\n+new\n+another\n",
      },
      { path: "src/created.ts", kind: { type: "add" }, diff: "first\nsecond\n" },
      { path: "src/deleted.ts", kind: { type: "delete" }, diff: "removed\n" },
    ];

    await events.completed(fileChange("patch-structured", changes));

    const result = events.result();
    const toolCall = firstContent(result.messagesSnapshot[1]);
    const expectedChanges = [
      { ...changes[0], stat: { added: 2, removed: 1 } },
      { ...changes[1], stat: { added: 2, removed: 0 } },
      { ...changes[2], stat: { added: 0, removed: 1 } },
    ];
    expect(toolCall.name).toBe("apply_patch");
    expect(toolCall.arguments).toEqual({ changes: expectedChanges });
  });

  it.each(["custom", "function", "exec", "cd-exec", "code-mode"] as const)(
    "persists the linked raw patch through %s (native success or raw-only rejection)",
    async (mode) => {
      const { params, events } = await persistedProjector("patch");
      const callId = "native-patch-raw-result";
      const patchInput =
        "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n+*** End Patch\n*** End Patch\n";

      const native = mode === "custom";
      const custom = native || mode === "code-mode";
      const shell = mode === "exec" || mode === "cd-exec";
      const input = shell
        ? {
            cmd: `${mode === "cd-exec" ? "cd /workspace && " : ""}apply_patch <<'PATCH'\n${patchInput}PATCH\n`,
          }
        : mode === "function"
          ? { input: patchInput }
          : mode === "code-mode"
            ? `// @exec: {}\nconst patch = \`${patchInput}\`\nconst result = await tools.apply_patch(patch)\ntext(result)`
            : patchInput;
      const name = mode === "code-mode" ? "exec" : shell ? "exec_command" : "apply_patch";
      await events.raw(rawCall(callId, name, input, custom));
      if (native) {
        await events.completed(
          fileChange(callId, [{ path: "runtime-tool-fixture-patch.txt", kind: { type: "add" } }]),
        );
      }
      const output = native
        ? "Successfully applied patch to runtime-tool-fixture-patch.txt"
        : workspaceRejection;
      const rawResult =
        mode === "code-mode"
          ? [
              { type: "input_text", text: "Script failed\nWall time 6.0 seconds\nOutput:\n" },
              { type: "input_text", text: `Script error:\n${output}` },
            ]
          : output;
      await events.raw(rawOutput(callId, rawResult, custom));

      const messages = await readTranscriptMessagesByIdentity(params);
      const call = firstContent(messages[0]);
      expect(call).toMatchObject({
        type: "toolCall",
        id: callId,
        name: "apply_patch",
        arguments: { input: patchInput, ...(mode === "cd-exec" ? { cwd: "/workspace" } : {}) },
      });
      const toolResult = requireRecord(messages[1], "native patch result");
      expect(toolResult).toMatchObject({
        role: "toolResult",
        toolCallId: callId,
        toolName: "apply_patch",
        isError: !native,
      });
      expect(firstContent(toolResult).text).toBe(
        typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult, null, 2),
      );
    },
  );

  it.each(["direct rejection", "code-mode nonzero exit", "code-mode input object"])(
    "mirrors raw command %s without a commandExecution item",
    async (mode) => {
      const { params, events } = await persistedProjector("command");
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
              { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
              {
                type: "input_text",
                text: JSON.stringify({
                  chunk_id: "denied",
                  wall_time_seconds: 0.1,
                  exit_code: 1,
                  output: "Error: EPERM: operation not permitted, open '../denied.txt'",
                }),
              },
            ];

      const custom = mode !== "direct rejection";
      const input = !custom
        ? args
        : mode === "code-mode input object"
          ? `const args = {cmd: ${JSON.stringify(args.cmd)}, workdir: '/workspace', yield_time_ms: 1000}; text(await tools.exec_command(args));`
          : `const result = await tools.exec_command(${JSON.stringify(args)}); text(result);`;
      await events.raw(rawCall(callId, custom ? "exec" : "exec_command", input, custom));
      await events.raw(rawOutput(callId, output, custom));

      const messages = await readTranscriptMessagesByIdentity(params);
      const call = firstContent(messages[0]);
      expect(call).toMatchObject({ type: "toolCall", id: callId, name: "bash" });
      expect(call.arguments).toEqual({ command: args.cmd, cwd: args.workdir });
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

  it("does not mistake patch text quoted inside a shell heredoc for a native patch", async () => {
    const command =
      "cat <<'TEXT'\napply_patch is documented below\n*** Begin Patch\n*** Add File: fake.txt\n+not a patch invocation\n*** End Patch\nTEXT\n";
    const { events } = await createProjection();
    const callId = "not-a-native-patch";

    await events.raw(rawCall(callId, "exec_command", { cmd: command }));
    await events.raw(rawOutput(callId, workspaceRejection));

    const result = events.result();
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
    const diff =
      "--- a/src/large.ts\n+++ b/src/large.ts\n@@ -1 +1,200 @@\n-old\n" +
      Array.from({ length: 200 }, (_, index) => `+${index}-${"x".repeat(96)}`).join("\n") +
      "\n";
    const { events } = await createProjection();

    await events.completed(
      fileChange("patch-large", [{ path: "src/large.ts", kind: { type: "update" }, diff }]),
    );

    const result = events.result();
    const toolCall = firstContent(result.messagesSnapshot[1]);
    const args = requireRecord(toolCall.arguments, "file-change arguments");
    const projectedChanges = requireArray(args.changes, "projected file changes");
    const projectedChange = requireRecord(projectedChanges[0], "projected file change");
    const projectedDiff = projectedChange.diff;
    if (typeof projectedDiff !== "string") {
      throw new Error("Expected bounded file-change diff");
    }
    expect(projectedDiff.length).toBeLessThanOrEqual(12_000);
    expect(projectedDiff.endsWith("\n")).toBe(true);
    expect(diff.startsWith(projectedDiff)).toBe(true);
    expect(projectedChange.diffTruncated).toBe(true);
    expect(projectedChange.stat).toEqual({ added: 200, removed: 1 });
  });

  it("preserves enclosing timeout provenance for failed native tools", async () => {
    const { events } = await createProjection(undefined, {
      runAbortSignal: AbortSignal.abort(
        Object.assign(new Error("turn timed out"), { name: "TimeoutError" }),
      ),
    });
    const commandItem = createNativeCommandItem({
      id: "cmd-aborted",
      status: "inProgress",
      exitCode: null,
      durationMs: null,
    });

    await events.started(commandItem);
    await events.completed({ ...commandItem, status: "failed", durationMs: 4 });
    await flushDiagnosticEvents();

    expect(diagnosticEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.error",
        toolCallId: "cmd-aborted",
        terminalReason: "timed_out",
      }),
    );
  });

  it.each([
    ["completed", "tool.execution.completed", undefined, undefined],
    ["failed", "tool.execution.error", "failed", undefined],
    ["cancelled", "tool.execution.error", "cancelled", undefined],
  ] as const)(
    "uses raw %s status for redacted native web-search audit actions",
    async (status, terminalType, terminalReason, errorCode) => {
      const { events } = await createProjection();
      const item = {
        id: "web-search-audit-1",
        type: "webSearch",
        query: "sensitive query",
        action: { type: "search", query: "sensitive query", queries: null },
      };

      await events.started(item, { startedAtMs: 1_750_000_000_000 });
      await events.completed(item, { completedAtMs: 1_750_000_000_042 });
      await events.raw({ id: item.id, type: "web_search_call", status, action: item.action });
      await flushDiagnosticEvents();

      const audit = diagnosticEvents.filter(
        (event) => "toolCallId" in event && event.toolCallId === item.id,
      );
      expect(audit).toMatchObject([
        {
          type: "tool.execution.started",
          toolName: "web_search",
          sourceTimestampMs: 1_750_000_000_000,
        },
        { type: terminalType, toolName: "web_search", sourceTimestampMs: 1_750_000_000_042 },
      ]);
      expect(
        audit.map((event) => ({
          terminalReason: "terminalReason" in event ? event.terminalReason : undefined,
          errorCode: "errorCode" in event ? event.errorCode : undefined,
        })),
      ).toEqual([
        { terminalReason: undefined, errorCode: undefined },
        { terminalReason, errorCode },
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
  const activeCall = {
    id: "mcp-grant-item",
    server: "docs/raw-name",
    tool: "lookup.raw",
    arguments: { query: "exact argument", limit: 3 },
  };
  const mcpItem = { type: "mcpToolCall", status: "inProgress", ...activeCall };

  it("correlates only a unique active MCP item using raw server and tool identities", async () => {
    const { projector, events } = await createProjection();
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
    await events.started(mcpItem);
    await events.started({ ...mcpItem, id: "other-server-item", server: "other-server" });
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toEqual(activeCall);

    const concurrentItem = { ...mcpItem, id: "concurrent-item", pluginId: "external-plugin" };
    await events.started(concurrentItem);
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
    await events.completed({ ...concurrentItem, status: "completed" });
    expect(projector.getActiveMcpToolCall(mcpItem.server)?.id).toBe(mcpItem.id);
    await events.completed({ ...mcpItem, status: "completed" });
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
  });

  it.each(["receipt", "projection"] as const)(
    "preserves active MCP correlation after a nonterminal completion at %s",
    async (phase) => {
      const { projector, events } = await createProjection();
      await events.started(mcpItem);
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
    const { projector, events } = await createProjection();
    await events.started(
      { ...mcpItem, ...("item" in testCase ? testCase.item : {}) },
      { ...("params" in testCase ? testCase.params : {}) },
    );
    expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
  });

  it.each(["closed", "finalized", "timed out"])(
    "does not correlate MCP items after the turn is %s",
    async (ending) => {
      const { projector, events } = await createProjection();
      await events.started(mcpItem);
      if (ending === "closed") {
        await projector.closeProjection();
      } else if (ending === "finalized") {
        events.result();
      } else {
        projector.markTimedOut();
      }
      await events.started({ ...mcpItem, id: "late-item" });
      expect(projector.getActiveMcpToolCall(mcpItem.server)).toBeUndefined();
    },
  );

  it.each(["open page", "aborted finalization"])(
    "keeps web-search outcomes unknown at %s without an explicit terminal",
    async (ending) => {
      const openPage = ending === "open page";
      const { events } = await createProjection(
        undefined,
        openPage ? undefined : { runAbortSignal: AbortSignal.abort("cancelled") },
      );
      const item = {
        id: "web-search-unknown",
        type: "webSearch",
        query: openPage ? "" : "sensitive extension query",
        action: openPage
          ? { type: "openPage", url: "https://example.com/sensitive" }
          : { type: "search", query: "sensitive extension query", queries: null },
      };
      await events.started(item);
      await events.completed(item);
      if (openPage) {
        await events.raw({
          id: item.id,
          type: "web_search_call",
          status: "open",
          action: { type: "open_page", url: "https://example.com/sensitive" },
        });
      } else {
        events.result();
      }
      await flushDiagnosticEvents();
      expectUnknownOutcome(item.id);
      expect(JSON.stringify(diagnosticEvents)).not.toContain(
        openPage ? "sensitive" : "sensitive extension query",
      );
    },
  );

  it("delivers completed assistant text when a native tool call finishes without a matching result", async () => {
    const answer = "The requested publish command was denied before execution.";
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const { events } = await createProjection(await createParams(), { trajectoryRecorder });

    await events.started(
      createNativeCommandItem({
        id: "cmd-denied",
        command: "node scripts/report.js --publish",
        status: "inProgress",
        exitCode: null,
        durationMs: null,
      }),
    );
    await events.complete([{ type: "agentMessage", id: "msg-denied", text: answer }]);

    const result = events.result();

    expect(readAttemptTerminal(result)).toMatchObject({
      promptError: null,
      promptErrorSource: null,
    });
    expect(result.lastToolError).toBeUndefined();
    expect(result.assistantTexts).toEqual([answer]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage).toMatchObject({
      toolCallId: "cmd-denied",
      toolName: "bash",
      isError: true,
    });
    expect(toolResultMessage.details).toEqual({ reason: "missing_tool_result" });
    expect(toolResultMessage.content).toEqual([
      { type: "text", text: expect.stringContaining("matching tool.result") },
    ]);
    const finalAssistant = requireRecord(result.messagesSnapshot[3], "final assistant message");
    expect(finalAssistant.content).toEqual([{ type: "text", text: answer }]);
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "tool.result",
      expect.objectContaining({
        toolCallId: "cmd-denied",
        name: "bash",
        status: "failed",
        isError: true,
        success: false,
        result: { status: "failed", reason: "missing_tool_result" },
        output: expect.stringContaining("without a matching tool.result"),
      }),
    );
  });
});
