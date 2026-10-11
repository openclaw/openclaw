import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  buildEmptyToolTelemetry,
  createProjector,
  describe,
  expect,
  forCurrentTurn,
  it,
  registerCodexEventProjectorTestLifecycle,
  requireArray,
  requireRecord,
  turnCompleted,
  createParams,
  formatToolAggregate,
  inferToolMetaFromArgs,
  vi,
  mockCallArg,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("Codex tool response fidelity", () => {
  function toolResult(projector: Awaited<ReturnType<typeof createProjector>>) {
    const results = projector
      .buildResult(buildEmptyToolTelemetry())
      .messagesSnapshot.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    return requireRecord(results[0], "result");
  }

  function outputText(result: Record<string, unknown>) {
    return requireRecord(requireArray(result.content, "content")[0], "output").text;
  }

  async function projectCodeModeOutput(
    output: string,
    input: string,
    name: "exec" | "wait" = "exec",
  ) {
    const projector = await createProjector();
    const callId = `outer-${name}`;
    for (const item of [
      name === "exec"
        ? { type: "custom_tool_call", call_id: callId, name, input }
        : { type: "function_call", call_id: callId, name, arguments: input },
      name === "exec"
        ? { type: "custom_tool_call_output", call_id: callId, output }
        : {
            type: "function_call_output",
            call_id: callId,
            output: [{ type: "input_text", text: output }],
          },
    ]) {
      await projector.handleNotification(forCurrentTurn("rawResponseItem/completed", { item }));
    }
    await projector.handleNotification(turnCompleted());
    return toolResult(projector);
  }

  // The response notification is distinct from the command's raw stdout. Codex
  // may further truncate history after constructing this response; do not claim
  // exact model-input fidelity from this notification alone.

  it("preserves structured text boundaries without moving private media into plaintext", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call",
          call_id: "structured",
          name: "exec",
          input: "text('result')",
        },
      }),
    );
    const text = " \r\n" + "x".repeat(34_766) + "TAIL\r\n ";
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: "structured",
          output: [
            { type: "input_text", text },
            { type: "input_image", image_url: "data:image/png;base64,PRIVATE_PAYLOAD" },
            { type: "input_text", text: "" },
          ],
        },
      }),
    );
    expect(outputText(toolResult(projector))).toBe(
      JSON.stringify(
        [
          { type: "input_text", text },
          { type: "input_image", omitted: true },
          { type: "input_text", text: "" },
        ],
        null,
        2,
      ),
    );
  });

  it.each([
    {
      label: "completed",
      output: "Script completed\nWall time 0.1 seconds\nOutput:\n" + "x".repeat(34_766),
      isError: false,
      outcome: undefined,
    },
  ])(
    "retains $label outer code-mode output under its own call ID",
    async ({ output, isError, outcome }) => {
      const result = await projectCodeModeOutput(
        output,
        "text(await tools.exec_command({cmd: 'transcript'}))",
      );
      expect(result.toolCallId).toBe("outer-exec");
      expect(result.isError).toBe(isError);
      expect(
        requireRecord(requireRecord(result["__openclaw"], "metadata").toolOutput, "provenance")
          .outcome,
      ).toBe(outcome);
      expect(outputText(result)).toBe(output);
    },
  );

  it.each([
    { order: "before", status: "failed", isError: true },
    { order: "after", status: "failed", isError: true },
  ])(
    "uses the native collaboration $status outcome when output arrives $order completion",
    async ({ order, status, isError }) => {
      const projector = await createProjector();
      const callId = `spawn-${order}-${status}`;
      const call = forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "function_call",
          call_id: callId,
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "inspect the owner" }),
        },
      });
      const output = forCurrentTurn("rawResponseItem/completed", {
        item: { type: "function_call_output", call_id: callId, output: "Agent started." },
      });
      const native = {
        type: "collabAgentToolCall",
        id: callId,
        tool: "spawnAgent",
        senderThreadId: "thread-1",
        receiverThreadIds: ["child-1"],
        agentsStates: {},
      };
      await projector.handleNotification(call);
      await projector.handleNotification(
        forCurrentTurn("item/started", { item: { ...native, status: "inProgress" } }),
      );
      if (order === "before") {
        await projector.handleNotification(output);
      }
      await projector.handleNotification(
        forCurrentTurn("item/completed", { item: { ...native, status } }),
      );
      if (order === "after") {
        await projector.handleNotification(output);
      }
      await projector.handleNotification(turnCompleted([{ ...native, status }]));

      const result = toolResult(projector);
      expect(result).toMatchObject({
        toolCallId: callId,
        toolName: "spawn_agent",
        isError,
        content: [{ type: "text", text: "Agent started." }],
        __openclaw: { toolOutput: { source: "provider-response", modelInput: "unverified" } },
      });
      expect(
        requireRecord(requireRecord(result["__openclaw"], "metadata").toolOutput, "provenance")
          .outcome,
      ).toBeUndefined();
    },
  );

  it.each([{ order: "after", aggregate: "null", aggregatedOutput: null }])(
    "preserves the complete response $order the terminal item with $aggregate aggregate",
    async ({ order, aggregatedOutput }) => {
      const projector = await createProjector();
      const output = " \n" + "transcript 😀\n".repeat(2_700) + "END OF TRANSCRIPT\n ";
      const command = {
        type: "commandExecution",
        id: "call-long",
        command: "transcript",
        status: "completed",
        aggregatedOutput,
        exitCode: 0,
      };
      await projector.handleNotification(
        forCurrentTurn("item/started", { item: { ...command, status: "inProgress" } }),
      );
      const response = forCurrentTurn("rawResponseItem/completed", {
        item: { type: "function_call_output", call_id: command.id, output },
      });
      if (order === "before") {
        await projector.handleNotification(response);
      }
      await projector.handleNotification(forCurrentTurn("item/completed", { item: command }));
      if (order === "after") {
        await projector.handleNotification(response);
      }
      await projector.handleNotification(turnCompleted([command]));
      const result = toolResult(projector);
      expect(outputText(result)).toBe(output);
      expect(result["__openclaw"]).toMatchObject({
        toolOutput: { source: "provider-response", modelInput: "unverified" },
      });
    },
  );
});

describe("streamed-output-echo", () => {
  type Projector = Awaited<ReturnType<typeof createProjector>>;

  function rawMessage(text: string, id = "raw-echo") {
    return forCurrentTurn("rawResponseItem/completed", {
      item: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] },
    });
  }

  function expectNoReply(projector: Projector) {
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
    return result;
  }

  it("keeps typed final answers that verbatim-equal tool output", async () => {
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult: vi.fn(),
    });
    const output = "command-output-line\nsecond-line";
    const item = createNativeCommandItem({
      id: "cmd-verbatim",
      command: "cat result.txt",
      aggregatedOutput: output,
      durationMs: 12,
    });
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          ...item,
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: item.id,
        delta: output,
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/completed", { item }));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "msg-verbatim", text: output },
      }),
    );
    await projector.handleNotification(turnCompleted());
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual([output]);
    expect(result.lastAssistant).toBeDefined();
    expect(result.currentAttemptAssistant).toBeDefined();
  });

  it("keeps a channel summary echo suppressed after later streamed output", async () => {
    const onToolResult = vi.fn();
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      messageChannel: "telegram",
      onToolResult,
      onAgentEvent,
    });
    const item = createNativeCommandItem({ id: "cmd-multi-shape" });
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...item, status: "inProgress", exitCode: null, durationMs: null },
      }),
    );
    const summary = onToolResult.mock.calls[0]?.[0].text;
    expect(summary).toBe("Bash");
    const output = "streamed-output-chunk-that-would-overwrite-summary";
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: item.id,
        delta: output,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { ...item, aggregatedOutput: output, exitCode: 2, durationMs: 12 },
      }),
    );
    const prepared = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.stream === "item" &&
          event.data.toolCallId === item.id &&
          !event.data.suppressChannelProgress,
      );
    expect(prepared.map((event) => event.data.itemId)).toEqual([
      "tool:cmd-multi-shape",
      "tool:cmd-multi-shape",
    ]);
    expect(prepared.at(-1)?.data.status).toBe("failed");
    expect(
      onToolResult.mock.calls.map(([payload]) => payload.channelData?.openclawToolProgressId),
    ).toEqual([prepared[0]?.data.itemId, prepared[0]?.data.itemId]);
    await projector.handleNotification(rawMessage(summary));
    await projector.handleNotification(turnCompleted());
    expectNoReply(projector);
  });

  it("retains oversized summary and normalized stream echo signatures across fine-grained deltas", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });
    const command = "pnpm test";
    const cwd = `/very-long-root/${"a".repeat(10_500)}`;
    const summary = formatToolAggregate(
      "bash",
      [inferToolMetaFromArgs("exec", { command, cwd }, { detailMode: "explain" }) ?? ""],
      { markdown: true },
    );
    expect(summary.length).toBeGreaterThan(10_000);
    const item = createNativeCommandItem({
      id: "cmd-summary-then-stream",
      command,
      cwd,
      status: "inProgress",
      exitCode: null,
      durationMs: null,
    });
    await projector.handleNotification(forCurrentTurn("item/started", { item }));
    expect(onToolResult.mock.calls[0]?.[0].text).toHaveLength(10_000);
    expect(onToolResult.mock.calls[0]?.[0].text).toContain(
      "OpenClaw truncated Codex native tool output",
    );
    // More than the former signature FIFO capacity; a trailing newline must not change matching.
    const chunks = Array.from(
      { length: 40 },
      (_, i) => `${"s".repeat(300)}${String(i).padStart(2, "0")}\n`,
    );
    for (const delta of chunks) {
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", { itemId: item.id, delta }),
      );
    }
    expect(onToolResult).toHaveBeenCalledTimes(21);
    expect(onToolResult.mock.calls[20]?.[0].text).toContain("...(truncated)...");
    await projector.handleNotification(rawMessage(summary, "raw-summary"));
    await projector.handleNotification(rawMessage(chunks.join(""), "raw-stream"));
    await projector.handleNotification(
      turnCompleted([createNativeCommandItem({ id: item.id, command, cwd })]),
    );
    const result = expectNoReply(projector);
    const toolResult = result.messagesSnapshot.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ toolCallId: item.id, toolName: "bash", isError: false });
    const output = toolResult?.content.find((block) => block.type === "text")?.text;
    expect(output).toHaveLength(10_000);
    expect(output).toContain("OpenClaw truncated Codex native tool output");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(summary.slice(0, 1_000));
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(chunks.join("").trim());
  });
});

describe("CodexAppServerEventProjector command output projection", () => {
  it.each([{ prefixLength: 7_999, delta: "😀tail", expectedChunk: "" }])(
    "keeps streamed progress UTF-16 safe with $prefixLength chars already emitted",
    async ({ prefixLength, delta, expectedChunk }) => {
      const onToolResult = vi.fn();
      const projector = await createProjector({
        ...(await createParams()),
        verboseLevel: "full",
        onToolResult,
      });

      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-progress-utf16",
          delta: "a".repeat(prefixLength),
        }),
      );
      onToolResult.mockClear();
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-progress-utf16",
          delta,
        }),
      );

      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(onToolResult).toHaveBeenCalledWith({
        text: `Bash\n\`\`\`txt\n${expectedChunk}...(truncated)...\n\`\`\``,
      });
      const text = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string }).text;
      expect(text).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    },
  );
});
