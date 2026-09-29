import {
  agentMessageDelta,
  createParams,
  createProjector,
  describe,
  expect,
  forCurrentTurn,
  it,
  registerCodexEventProjectorTestLifecycle,
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
async function createNoticeProjector(provider = "openai") {
  const onAgentEvent = vi.fn();
  const projector = await createProjector({ ...(await createParams()), provider, onAgentEvent });
  return {
    projector,
    onAgentEvent,
    buffer: (params = buffering) =>
      projector.handleNotification(forCurrentTurn("model/safetyBuffering/updated", params)),
    notices: () =>
      onAgentEvent.mock.calls.map(([event]) => event).filter((event) => event.stream === "notice"),
  };
}

describe("CodexAppServerEventProjector cyber notices", () => {
  it("clears hidden buffering without claiming a model switch", async () => {
    const { buffer, notices, onAgentEvent } = await createNoticeProjector();
    await buffer();
    await buffer({ ...buffering, useCases: [], showBufferingUi: false });
    expect(notices()).toEqual([
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
        data: { phase: "provider_policy", category: "cyber", state: "cleared", provider: "openai" },
      },
    ]);
    expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "fallback")).toBe(false);
  });
  it("shows the first buffering notice after commentary and retires it when the answer starts", async () => {
    const { projector, buffer, notices } = await createNoticeProjector();
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "commentary",
          phase: "commentary",
          text: "I will review the code.",
        },
      }),
    );
    await buffer();
    await projector.handleNotification(agentMessageDelta("Ready"));
    await buffer();
    expect(notices().map((event) => event.data.state)).toEqual(["buffering", "cleared"]);
  });
  it("ignores another use case", async () => {
    const { buffer, onAgentEvent } = await createNoticeProjector();
    await buffer({ ...buffering, useCases: ["bio"] });
    expect(onAgentEvent).not.toHaveBeenCalled();
  });
  it("does not label another provider as OpenAI", async () => {
    const { buffer, onAgentEvent } = await createNoticeProjector("other");
    await buffer();
    expect(onAgentEvent).not.toHaveBeenCalled();
  });
});
