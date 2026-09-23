import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  forCurrentTurn,
  agentMessageDelta,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector started text", () => {
  it.each(["final_answer", "commentary"])(
    "includes started-item text in the %s stream before subsequent deltas",
    async (phase) => {
      const onAgentEvent = vi.fn();
      const onPartialReply = vi.fn();
      const projector = await createProjector({
        ...(await createParams()),
        onAgentEvent,
        onPartialReply,
      });

      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { type: "agentMessage", id: "msg-1", phase, text: "Hello " },
        }),
      );
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: phase === "commentary" ? "item" : "assistant",
        data: expect.objectContaining(
          phase === "commentary" ? { progressText: "Hello" } : { text: "Hello ", delta: "Hello " },
        ),
      });

      await projector.handleNotification(agentMessageDelta("world"));
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { type: "agentMessage", id: "msg-1", phase, text: "Hello " },
        }),
      );
      await projector.handleNotification(agentMessageDelta("!"));

      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: phase === "commentary" ? "item" : "assistant",
        data: expect.objectContaining(
          phase === "commentary"
            ? { progressText: "Hello world!" }
            : { text: "Hello world!", delta: "!" },
        ),
      });
      if (phase === "commentary") {
        expect(onPartialReply).not.toHaveBeenCalled();
      } else {
        expect(onPartialReply.mock.calls.map(([payload]) => payload)).toEqual([
          { text: "Hello ", delta: "Hello " },
          { text: "Hello world", delta: "world" },
          { text: "Hello world!", delta: "!" },
        ]);
      }
    },
  );
});
