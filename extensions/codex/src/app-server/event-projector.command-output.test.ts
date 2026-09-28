import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  TURN_ID,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  mockCallArg,
  findAgentEvent,
  forCurrentTurn,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector command output projection", () => {
  it("uses streamed command output when final command snapshots omit aggregated output", async () => {
    const onAgentEvent = vi.fn();
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(
      {
        ...(await createParams()),
        onAgentEvent,
      },
      {
        trajectoryRecorder,
      },
    );

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-1",
        delta: "status passed\n",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-1",
        delta: "json /tmp/scenario.json\n",
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        createNativeCommandItem({
          id: "cmd-1",
          command: "python scripts/run_demo_scenario.py",
        }),
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage).toMatchObject({
      role: "toolResult",
      toolCallId: "cmd-1",
      toolName: "bash",
      content: [{ type: "text", text: "status passed\njson /tmp/scenario.json\n" }],
    });
    expect(trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "tool.result",
      expect.objectContaining({
        itemId: "cmd-1",
        output: "status passed\njson /tmp/scenario.json",
      }),
    );
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-1",
      name: "bash",
    }).data;
    expect(toolResult.result).toEqual({ status: "completed", exitCode: 0, durationMs: 42 });
  });

  it("preserves complete final command output across the old UTF-16 transcript boundary", async () => {
    const projector = await createProjector();
    // The old mirror cap cut this emoji and discarded the entire suffix.
    const prefix = "a".repeat(9_886);
    const aggregatedOutput = `${prefix}😀${"a".repeat(400)}`;

    await projector.handleNotification(
      turnCompleted([
        createNativeCommandItem({
          id: "cmd-utf16-final",
          command: "printf output",
          aggregatedOutput,
        }),
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const message = requireRecord(result.messagesSnapshot[2], "tool result message");
    const content = requireArray(message.content, "tool result content");
    const item = requireRecord(content[0], "tool result content item");
    expect(item.type).toBe("text");
    expect(item.text).toBe(aggregatedOutput);
  });

  it.each([
    { prefixLength: 7_999, delta: "😀tail", expectedChunk: "" },
    { prefixLength: 7_998, delta: "x😀tail", expectedChunk: "x\n" },
  ])(
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
        text: `🛠️ Bash\n\`\`\`txt\n${expectedChunk}...(truncated)...\n\`\`\``,
      });
      const text = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string }).text;
      expect(text).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    },
  );

  it("freezes streamed raw prefix after UTF-16-safe truncation so full-output echoes stay suppressed", async () => {
    const projector = await createProjector();
    // First over-cap delta ends mid-surrogate: truncateUtf16Safe backs up and
    // leaves spare capacity under the notice budget. Later deltas must not fill it.
    const prefix = "a".repeat(9_886);
    const firstDelta = `${prefix}😀${"a".repeat(400)}`;
    const moreDeltas = ["more-after-cap-1", "more-after-cap-2", "tail-chunk"];
    const fullOutput = `${firstDelta}${moreDeltas.join("")}`;

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-freeze-prefix",
        delta: firstDelta,
      }),
    );
    for (const delta of moreDeltas) {
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-freeze-prefix",
          delta,
        }),
      );
    }

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-freeze-full-output",
          role: "assistant",
          content: [{ type: "output_text", text: fullOutput }],
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        createNativeCommandItem({
          id: "cmd-freeze-prefix",
          command: "printf output",
        }),
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
  });

  it("caps streamed command output used for replay when snapshots omit aggregated output", async () => {
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(await createParams(), {
      trajectoryRecorder,
    });

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-stream-large",
        delta: "s".repeat(12_345),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-stream-large",
        delta: "e".repeat(678),
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        createNativeCommandItem({
          id: "cmd-stream-large",
          command: "python scripts/run_demo_scenario.py",
        }),
      ]),
    );

    const output = (
      trajectoryRecorder.recordEvent.mock.calls.find(([type]) => type === "tool.result")?.[1] as
        | { output?: string }
        | undefined
    )?.output;
    expect(output).toHaveLength(10_000);
    expect(output).toContain("OpenClaw truncated Codex native tool output");
    expect(output).toContain("original 13023 chars");
    expect(output).toContain("showing 10000");
    expect(output?.match(/OpenClaw truncated Codex native tool output/g)).toHaveLength(1);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResultMessage = result.messagesSnapshot.find(
      (message) => requireRecord(message, "message").role === "toolResult",
    );
    const toolResultContent = requireArray(
      requireRecord(toolResultMessage, "tool result message").content,
      "tool result content",
    );
    const toolResultContentItem = requireRecord(toolResultContent[0], "tool result content item");
    expect(toolResultContentItem.type).toBe("text");
    expect(toolResultContentItem.text).toHaveLength(10_000);
    expect(toolResultContentItem.text).toContain("OpenClaw truncated Codex native tool output");
    expect(toolResultMessage).toMatchObject({
      __openclaw: { toolOutput: { source: "execution", captureTruncated: true } },
    });
  });

  it("uses streamed command output for failed native tool errors", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-streamed-failure",
        delta: "fatal: missing fixture\n",
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        createNativeCommandItem({
          id: "cmd-streamed-failure",
          status: "failed",
          exitCode: 1,
        }),
      ]),
    );

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual({
      toolName: "bash",
      meta: "run tests (workspace)",
      error: "fatal: missing fixture",
      mutatingAction: true,
    });
  });

  it("does not duplicate native tool starts when the snapshot completes a started item", async () => {
    const onAgentEvent = vi.fn();
    const trajectoryRecorder = {
      filePath: "trajectory.jsonl",
      recordEvent: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const projector = await createProjector(
      { ...(await createParams()), onAgentEvent },
      { trajectoryRecorder },
    );
    const commandItem = createNativeCommandItem({
      id: "cmd-started",
      aggregatedOutput: "ok",
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...commandItem, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(turnCompleted([commandItem]));

    const toolEvents = onAgentEvent.mock.calls
      .map((call) => requireRecord(call[0], "agent event"))
      .filter((event) => event.stream === "tool")
      .map((event) => requireRecord(event.data, "agent event data"));
    expect(
      toolEvents.filter((event) => event.phase === "start" && event.itemId === "cmd-started"),
    ).toHaveLength(1);
    expect(
      toolEvents.filter((event) => event.phase === "result" && event.itemId === "cmd-started"),
    ).toHaveLength(1);
    expect(
      trajectoryRecorder.recordEvent.mock.calls.filter(([type]) => type === "tool.call"),
    ).toHaveLength(1);
    expect(
      trajectoryRecorder.recordEvent.mock.calls.filter(([type]) => type === "tool.result"),
    ).toHaveLength(1);
  });

  it("does not synthesize completed progress for running turn completion snapshots", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      turnCompleted([
        createNativeCommandItem({
          id: "cmd-running-snapshot",
          status: "inProgress",
          exitCode: null,
          durationMs: null,
        }),
        {
          type: "imageGeneration",
          id: "image-running-snapshot",
          status: "in_progress",
          revisedPrompt: null,
          result: null,
        },
      ]),
    );

    const toolEvents = onAgentEvent.mock.calls
      .map((call) => requireRecord(call[0], "agent event"))
      .filter((event) => event.stream === "tool")
      .map((event) => requireRecord(event.data, "agent event data"));
    expect(toolEvents).toEqual([]);
  });

  it("does not synthesize progress for stale prior-turn snapshot items", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      turnCompleted([
        createNativeCommandItem({
          id: "cmd-prior-turn",
          turnId: "turn-old",
          aggregatedOutput: "ok",
        }),
        createNativeCommandItem({
          id: "cmd-current-turn",
          turnId: TURN_ID,
          aggregatedOutput: "ok",
        }),
      ]),
    );

    const toolEvents = onAgentEvent.mock.calls
      .map((call) => requireRecord(call[0], "agent event"))
      .filter((event) => event.stream === "tool")
      .map((event) => requireRecord(event.data, "agent event data"));
    expect(toolEvents.map((event) => event.itemId)).toEqual([
      "cmd-current-turn",
      "cmd-current-turn",
    ]);
  });
});
