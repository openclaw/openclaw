import { afterEach, beforeEach } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  THREAD_ID,
  flushDiagnosticEvents,
  createProjector,
  createParams,
  path,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  forCurrentTurn,
  type DiagnosticEventPayload,
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
      label: "workspace rejection before its native item",
      ...workspaceRejection,
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
      label: "workdir-scoped exec-command workspace rejection without a native FileChange item",
      ...workspaceRejection,
      functionCall: true,
      execCommand: true,
      executionWorkdir: "/repo/subdir",
      omitNativeItem: true,
    },
    {
      label: "code-mode native workspace rejection without a FileChange item",
      ...workspaceRejection,
      codeMode: (input: string) =>
        `const result = await tools.apply_patch(${JSON.stringify(input)});\ntext(result);\n`,
      omitNativeItem: true,
    },
    {
      label: "code-mode input-variable workspace rejection without a FileChange item",
      ...workspaceRejection,
      codeMode: (input: string) =>
        `const patch = ${JSON.stringify(input)};\ntext(await tools.apply_patch(patch));\n`,
      omitNativeItem: true,
    },
    {
      label: "code-mode direct literal workspace rejection",
      ...workspaceRejection,
      codeMode: (input: string) => `text(await tools.apply_patch(${JSON.stringify(input)}));`,
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

  it.each([
    "direct rejection",
    "code-mode rejection",
    "code-mode nonzero exit",
    "code-mode input object",
  ])("mirrors raw command %s without a commandExecution item", async (mode) => {
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
  });

  it("does not classify an unrecognized raw patch failure as a success", async () => {
    const projector = await createProjector();
    const callId = "native-patch-unrecognized-failure";
    await notify(projector, "rawResponseItem/completed", {
      item: {
        type: "custom_tool_call",
        call_id: callId,
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: broken.txt\n+broken\n*** End Patch\n",
      },
    });
    await notify(projector, "rawResponseItem/completed", {
      item: {
        type: "custom_tool_call_output",
        call_id: callId,
        output: "apply_patch failed: invalid patch",
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = requireRecord(result.messagesSnapshot[2], "unresolved native patch result");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: callId,
      toolName: "apply_patch",
      isError: true,
    });
  });

  it.each([
    {
      label: "patch text quoted inside a shell heredoc",
      command:
        "cat <<'TEXT'\napply_patch is documented below\n*** Begin Patch\n*** Add File: fake.txt\n+not a patch invocation\n*** End Patch\nTEXT\n",
    },
    {
      label: "a nested apply_patch heredoc",
      command:
        "cat <<'OUTER'\napply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: fake.txt\n+not a patch invocation\n*** End Patch\nPATCH\nOUTER\n",
    },
    {
      label: "a user-created absolute-path executable",
      command:
        "/workspace/fake/apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: fake.txt\n+not a native patch invocation\n*** End Patch\nPATCH\n",
    },
    {
      label: "an expanding unquoted patch delimiter",
      command:
        "apply_patch <<PATCH\n*** Begin Patch\n*** Add File: fake.txt\n+$(touch /tmp/not-a-native-patch)\n*** End Patch\nPATCH\n",
    },
    {
      label: "an expanding working-directory operand",
      command:
        "cd $(touch /tmp/not-a-native-patch) && apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: fake.txt\n+not a native patch invocation\n*** End Patch\nPATCH\n",
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

  it.each([["cancelled", "cancelled"]] as const)(
    "finalizes an active native tool as %s when building an interrupted result",
    async (abortReason, terminalReason) => {
      const abortController = new AbortController();
      abortController.abort(abortReason);
      const projector = await createProjector(undefined, {
        runAbortSignal: abortController.signal,
      });

      await notify(projector, "item/started", {
        item: createNativeCommandItem({
          id: "cmd-active-abort",
          status: "inProgress",
          exitCode: null,
          durationMs: null,
        }),
      });
      projector.buildResult(buildEmptyToolTelemetry());
      await flushDiagnosticEvents();

      expect(diagnosticEvents).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "cmd-active-abort",
          terminalReason,
        }),
      );
      expect(
        diagnosticEvents
          .filter((event) => "toolCallId" in event && event.toolCallId === "cmd-active-abort")
          .map((event) => event.type),
      ).toEqual(["tool.execution.started", "tool.execution.error"]);
    },
  );

  it.each([
    [
      "collaboration",
      {
        id: "collab-audit-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: THREAD_ID,
        receiverThreadIds: ["child-thread-1"],
        prompt: "sensitive prompt text",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
      "collab.spawnAgent",
    ],
    [
      "image view",
      {
        id: "image-view-audit-1",
        type: "imageView",
        path: "/workspace/sensitive-filename.png",
      },
      "image_view",
    ],
  ] as const)(
    "emits metadata-only lifecycle diagnostics for native %s items",
    async (_, item, toolName) => {
      const projector = await createProjector();

      await notify(projector, "item/started", { item, startedAtMs: 1_750_000_000_000 });
      await notify(projector, "item/completed", { item, completedAtMs: 1_750_000_000_042 });
      await flushDiagnosticEvents();

      expect(
        diagnosticEvents
          .filter((event) => "toolCallId" in event && event.toolCallId === item.id)
          .map((event) => ({
            type: event.type,
            toolName: "toolName" in event ? event.toolName : null,
          })),
      ).toEqual([
        { type: "tool.execution.started", toolName },
        { type: "tool.execution.completed", toolName },
      ]);
      expect(JSON.stringify(diagnosticEvents)).not.toContain("sensitive");
    },
  );

  it.each([
    ["completed", "tool.execution.completed", undefined, undefined],
    ["failed", "tool.execution.error", "failed", undefined],
    ["cancelled", "tool.execution.error", "cancelled", undefined],
    [undefined, "tool.execution.error", "failed", "tool_outcome_unknown"],
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
