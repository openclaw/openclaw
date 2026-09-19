import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector assistant authority", () => {
  it.each(["final_answer", undefined])(
    "preserves an empty typed %s completion when its raw echo contains hidden markup",
    async (phase) => {
      const onAgentEvent = vi.fn();
      const projector = await createProjector({ ...(await createParams()), onAgentEvent });
      const item = { type: "agentMessage", id: "msg-hidden", phase, text: "" };

      await projector.handleNotification(forCurrentTurn("item/started", { item }));
      await projector.handleNotification(forCurrentTurn("item/completed", { item }));
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "message",
            id: item.id,
            role: "assistant",
            phase,
            content: [{ type: "output_text", text: "<oai-mem-citation>source</oai-mem-citation>" }],
          },
        }),
      );
      await projector.handleNotification(turnCompleted([]));

      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.assistantTexts).toEqual([]);
      expect(result.lastAssistant).toBeUndefined();
      expect(result.currentAttemptAssistant).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "" }],
      });
      expect(result.messagesSnapshot.filter((message) => message.role === "assistant")).toEqual([]);
      expect(
        onAgentEvent.mock.calls.filter(
          ([event]) =>
            event.stream === "assistant" ||
            (event.stream === "item" && event.data.kind === "answer_candidate"),
        ),
      ).toEqual([]);
    },
  );

  it("does not reselect a final answer superseded by late tool work", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );

    const lateTool = {
      type: "commandExecution",
      id: "late-tool",
      command: "/bin/bash -lc 'printf late'",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "late",
      exitCode: 0,
      durationMs: 1,
    };
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...lateTool, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/completed", { item: lateTool }));
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
        lateTool,
      ]),
    );

    const candidateStatuses = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "answer_candidate")
      .map((event) => event.data.status);
    expect(candidateStatuses).toEqual(["candidate", "superseded"]);
  });

  it("selects an unphased final answer supplied only by the completed-turn snapshot", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "answer-unphased", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["done"]);
    expect(result.messagesSnapshot.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      }),
    );
    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "item" && event.data.kind === "answer_candidate")
        .map((event) => event.data),
    ).toEqual([
      expect.objectContaining({
        itemId: "answer-unphased",
        status: "selected",
        progressText: "done",
        hideFromChannelProgress: true,
      }),
    ]);
  });
});
