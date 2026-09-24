import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  formatToolAggregate,
  inferToolMetaFromArgs,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  mockCallArg,
  forCurrentTurn,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

const startedCommand = {
  type: "commandExecution",
  processId: null,
  source: "agent",
  status: "inProgress",
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
};

describe("CodexAppServerEventProjector streamed output echo filtering", () => {
  it("keeps typed agentMessage finals that verbatim-equal tool progress text", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });
    const commandOutput = "command-output-line\nsecond-line";

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          ...startedCommand,
          id: "cmd-verbatim",
          command: "cat result.txt",
          cwd: "/workspace",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-verbatim",
        delta: commandOutput,
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          ...startedCommand,
          id: "cmd-verbatim",
          command: "cat result.txt",
          cwd: "/workspace",
          status: "completed",
          aggregatedOutput: commandOutput,
          exitCode: 0,
          durationMs: 12,
        },
      }),
    );
    // Typed finals are deliberate model output, including verbatim tool output.
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "msg-verbatim",
          text: commandOutput,
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([commandOutput]);
    expect(result.lastAssistant).toBeDefined();
    expect(result.currentAttemptAssistant).toBeDefined();
  });

  it("does not promote a raw echo of an earlier tool progress summary after later stream output", async () => {
    const onToolResult = vi.fn();
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      messageChannel: "telegram",
      onToolResult,
      onAgentEvent,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          ...startedCommand,
          id: "cmd-multi-shape",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
        },
      }),
    );
    const summaryText = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string }).text;
    expect(summaryText).toBe("🛠️ Bash");

    await projector.handleNotification(
      forCurrentTurn("item/commandExecution/outputDelta", {
        itemId: "cmd-multi-shape",
        delta: "streamed-output-chunk-that-would-overwrite-summary",
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-multi-shape",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          status: "completed",
          aggregatedOutput: "streamed-output-chunk-that-would-overwrite-summary",
          exitCode: 2,
          durationMs: 12,
        },
      }),
    );
    const prepared = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.stream === "item" &&
          event.data.toolCallId === "cmd-multi-shape" &&
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
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-earlier-summary",
          role: "assistant",
          content: [{ type: "output_text", text: summaryText }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toBeUndefined();
  });

  it.each([
    {
      scenario: "a full mechanical stream of chunks",
      command: "pnpm test extensions/codex",
      // Each chunk registers a distinct raw signature; the summary must survive the cap.
      chunks: Array.from({ length: 20 }, (_, i) => `${"s".repeat(1_500)}${i}`),
      echoStream: false,
      checkSnapshot: false,
    },
    {
      scenario: "a later shorter stream",
      command: "pnpm test",
      chunks: [`${"o".repeat(2_000)}stream-tail`],
      echoStream: true,
      checkSnapshot: true,
    },
    {
      scenario: "fine-grained streamed deltas",
      command: "pnpm test",
      // Forty cumulative prefixes overflowed the old FIFO and evicted the summary.
      chunks: Array.from(
        { length: 40 },
        (_, i) => `${"s".repeat(300)}${String(i).padStart(2, "0")}`,
      ),
      echoStream: true,
      checkSnapshot: false,
    },
  ])(
    "does not promote raw summary or stream echoes after $scenario",
    async ({ command, chunks, echoStream, checkSnapshot }) => {
      const onToolResult = vi.fn();
      const projector = await createProjector({
        ...(await createParams()),
        verboseLevel: "full",
        onToolResult,
      });
      const cwd = `/very-long-root/${"a".repeat(10_500)}`;
      const rawSummaryText = formatToolAggregate(
        "bash",
        [inferToolMetaFromArgs("exec", { command, cwd }, { detailMode: "explain" }) ?? ""],
        { markdown: true },
      );
      expect(rawSummaryText.length).toBeGreaterThan(10_000);

      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { ...startedCommand, id: "cmd-summary-then-stream", command, cwd },
        }),
      );
      const emittedSummary = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string })
        .text;
      expect(emittedSummary).toHaveLength(10_000);

      for (const delta of chunks) {
        await projector.handleNotification(
          forCurrentTurn("item/commandExecution/outputDelta", {
            itemId: "cmd-summary-then-stream",
            delta,
          }),
        );
      }
      const rawEchoes = echoStream ? [rawSummaryText, chunks.join("")] : [rawSummaryText];
      for (const [index, text] of rawEchoes.entries()) {
        await projector.handleNotification(
          forCurrentTurn("rawResponseItem/completed", {
            item: {
              type: "message",
              id: `raw-echo-${index}`,
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          }),
        );
      }
      await projector.handleNotification(turnCompleted());

      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.assistantTexts).toEqual([]);
      expect(result.lastAssistant).toBeUndefined();
      expect(result.currentAttemptAssistant).toBeUndefined();
      if (checkSnapshot) {
        expect(JSON.stringify(result.messagesSnapshot)).not.toContain(
          rawSummaryText.slice(0, 1_000),
        );
        expect(JSON.stringify(result.messagesSnapshot)).not.toContain("stream-tail");
      }
    },
  );
});
