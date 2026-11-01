import {
  agentMessageDelta,
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  expect,
  forCurrentTurn,
  it,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
  vi,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

it("keeps post-final assistant text out of streaming, async delivery, and final payloads", async () => {
  const onAgentEvent = vi.fn();
  const onAssistantMessageStart = vi.fn();
  const onPartialReply = vi.fn();
  const onAsyncDelivery = vi.fn(() => "settled" as const);
  const telemetry = { ...buildEmptyToolTelemetry(), finalSourceReplyDelivered: false };
  const projector = await createProjector(
    { ...(await createParams()), onAgentEvent, onAssistantMessageStart, onPartialReply },
    {
      hasDeliveredFinalSourceReply: () => telemetry.finalSourceReplyDelivered,
      onAsyncDelivery,
    },
  );
  const progress = { type: "agentMessage", id: "progress", phase: "final_answer", text: "" };
  await projector.handleNotification(forCurrentTurn("item/started", { item: progress }));
  await projector.handleNotification(agentMessageDelta("Working.", progress.id));
  expect(onPartialReply).toHaveBeenCalled();
  onAgentEvent.mockClear();
  onAssistantMessageStart.mockClear();
  onPartialReply.mockClear();
  await projector.handleNotification(
    forCurrentTurn("item/completed", {
      item: { type: "agentMessage", id: "before", phase: "commentary", text: "Before final." },
    }),
  );
  onAgentEvent.mockClear();
  telemetry.finalSourceReplyDelivered = true;
  const codaItems = [
    { type: "agentMessage", id: "final", phase: "final_answer", text: "Extra answer." },
    { type: "agentMessage", id: "commentary", phase: "commentary", text: "Extra commentary." },
    { type: "agentMessage", id: "async", delivery: "async", text: "Extra block reply." },
  ];
  for (const item of codaItems) {
    await projector.handleNotification(forCurrentTurn("item/started", { item }));
    await projector.handleNotification(agentMessageDelta(item.text, item.id));
    await projector.handleNotification(forCurrentTurn("item/completed", { item }));
  }
  await projector.handleNotification(turnCompleted(codaItems));
  const result = projector.buildResult({ ...telemetry, finalSourceReplyDelivered: true });

  expect(onPartialReply).not.toHaveBeenCalled();
  expect(onAssistantMessageStart).not.toHaveBeenCalled();
  expect(onAsyncDelivery).not.toHaveBeenCalled();
  expect(onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant")).toEqual([]);
  expect(
    onAgentEvent.mock.calls.filter(
      ([event]) =>
        event.stream === "item" && ["preamble", "answer_candidate"].includes(event.data.kind),
    ),
  ).toEqual([]);
  expect(result.assistantTexts).toEqual([]);
  expect(result.lastAssistant).toBeUndefined();
  expect(result.currentAttemptAssistant).toBeUndefined();
  expect(JSON.stringify(result.messagesSnapshot)).not.toContain("Extra");
  expect(JSON.stringify(result.messagesSnapshot)).toContain("Before final.");
});
