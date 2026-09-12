import {
  agentMessageDelta,
  createParams,
  createProjector,
  describe,
  expect,
  forCurrentTurn,
  it,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
  vi,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

const buffering = {
  model: "gpt-5.6-sol",
  useCases: ["cyber"],
  reasons: ["user_risk"],
  showBufferingUi: true,
  fasterModel: "gpt-5.4-codex-mini",
};

describe("CodexAppServerEventProjector cyber notices", () => {
  it.each([
    {
      end: "hidden",
      notification: forCurrentTurn("model/safetyBuffering/updated", {
        ...buffering,
        useCases: [],
        showBufferingUi: false,
      }),
    },
    { end: "assistant delta", notification: agentMessageDelta("Ready") },
    ...(["item/started", "item/completed"] as const).map((method) => ({
      end: method,
      notification: forCurrentTurn(method, {
        item: { type: "agentMessage", id: "msg-1", text: "Ready" },
      }),
    })),
    {
      end: "raw assistant",
      notification: forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          role: "assistant",
          id: "msg-1",
          content: [{ type: "output_text", text: "Ready" }],
        },
      }),
    },
    { end: "completion", notification: turnCompleted([]) },
  ])(
    "clears transient buffering on $end without claiming a model switch",
    async ({ end, notification }) => {
      const onAgentEvent = vi.fn();
      const projector = await createProjector({ ...(await createParams()), onAgentEvent });
      await projector.handleNotification(
        forCurrentTurn("model/safetyBuffering/updated", buffering),
      );
      await projector.handleNotification(notification);
      if (end !== "hidden") {
        await projector.handleNotification(
          forCurrentTurn("model/safetyBuffering/updated", buffering),
        );
      }
      expect(
        onAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === "notice"),
      ).toEqual([
        {
          stream: "notice",
          data: {
            phase: "provider_policy",
            category: "cyber",
            state: "buffering",
            provider: "openai",
            model: buffering.model,
            fallbackModel: buffering.fasterModel,
          },
        },
        {
          stream: "notice",
          data: {
            phase: "provider_policy",
            category: "cyber",
            state: "cleared",
            provider: "openai",
          },
        },
      ]);
      expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "fallback")).toBe(false);
    },
  );

  it("keeps buffering visible when an empty assistant item starts", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-1", text: "" },
      }),
    );
    await projector.handleNotification(forCurrentTurn("model/safetyBuffering/updated", buffering));
    expect(
      onAgentEvent.mock.calls.map(([event]) => event).filter((event) => event.stream === "notice"),
    ).toEqual([expect.objectContaining({ data: expect.objectContaining({ state: "buffering" }) })]);
  });

  it("shows the first buffering notice after earlier commentary in the same turn", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "commentary-1",
          phase: "commentary",
          text: "I will review the code.",
        },
      }),
    );
    await projector.handleNotification(forCurrentTurn("model/safetyBuffering/updated", buffering));
    await projector.handleNotification(agentMessageDelta("Ready"));
    await projector.handleNotification(forCurrentTurn("model/safetyBuffering/updated", buffering));
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "notice")
        .map((event) => event.data.state),
    ).toEqual(["buffering", "cleared"]);
  });

  it("does not open a buffering notice after the turn completed without one", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(turnCompleted([]));
    await projector.handleNotification(forCurrentTurn("model/safetyBuffering/updated", buffering));
    expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "notice")).toBe(false);
  });

  it.each([
    { label: "another turn", params: { ...buffering, turnId: "other-turn" } },
    { label: "another thread", params: { ...buffering, threadId: "other-thread" } },
    { label: "another use case", params: { ...buffering, useCases: ["bio"] } },
    {
      label: "unstructured cyber text",
      params: { ...buffering, useCases: [], reasons: ["cyber"] },
    },
    { label: "hidden buffering", params: { ...buffering, showBufferingUi: false } },
  ])("ignores $label", async ({ params }) => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(forCurrentTurn("model/safetyBuffering/updated", params));
    expect(onAgentEvent).not.toHaveBeenCalled();
  });

  it("does not label another provider as OpenAI", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      provider: "other",
      onAgentEvent,
    });
    await projector.handleNotification(forCurrentTurn("model/safetyBuffering/updated", buffering));
    expect(onAgentEvent).not.toHaveBeenCalled();
  });

  it("does not turn unrelated provider reroutes into cyber notices", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(
      forCurrentTurn("model/rerouted", {
        fromModel: buffering.model,
        toModel: buffering.fasterModel,
        reason: "other",
      }),
    );
    expect(onAgentEvent.mock.calls.map(([event]) => event.stream)).toEqual(["fallback"]);
  });
});
