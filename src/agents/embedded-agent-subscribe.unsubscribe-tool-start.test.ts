import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { describe, expect, it } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { countActiveToolExecutions } from "./embedded-agent-subscribe.handlers.tools.start.js";

describe("subscribeEmbeddedAgentSession unsubscribe tool cleanup", () => {
  it("releases the settled session while terminal metadata remains writable", async () => {
    function completedSubscription() {
      const { session, subscription } = createSubscribedSessionHarness({ runId: "retention" });
      subscription.setTerminalLifecycleMeta({ replayInvalid: true });
      expect(subscription.getReplayState().replayInvalid).toBe(true);
      subscription.setTerminalLifecycleMeta({ replayInvalid: false });
      expect(subscription.getReplayState().replayInvalid).toBe(false);
      subscription.unsubscribe();
      return {
        session: new WeakRef(session),
        setTerminalLifecycleMeta: subscription.setTerminalLifecycleMeta,
      };
    }
    const completed = Array.from({ length: 20 }, completedSubscription);
    const control = new WeakRef({});
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    expect(completed.filter(({ session }) => session.deref())).toHaveLength(0);
    completed[0]!.setTerminalLifecycleMeta({ replayInvalid: true, livenessState: "blocked" });
  });

  it("removes only the unsubscribed run's unfinished tool starts", () => {
    const first = createSubscribedSessionHarness({ runId: "cleanup-first" });
    const second = createSubscribedSessionHarness({ runId: "cleanup-second" });

    first.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "first-tool",
      args: { path: "/tmp/first" },
    });
    second.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "second-tool",
      args: { path: "/tmp/second" },
    });

    expect(countActiveToolExecutions("cleanup-first")).toBe(1);
    expect(countActiveToolExecutions("cleanup-second")).toBe(1);

    first.subscription.unsubscribe();

    expect(countActiveToolExecutions("cleanup-first")).toBe(0);
    expect(countActiveToolExecutions("cleanup-second")).toBe(1);

    second.subscription.unsubscribe();
    expect(countActiveToolExecutions("cleanup-second")).toBe(0);
  });
});
