import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { resolveEmbeddedRunSessionLanePolicy } from "./lane-runtime.js";

afterEach(() => {
  resetCommandQueueStateForTest();
});

describe("embedded run lane priority", () => {
  it("runs a foreground user turn before queued inter-session work", async () => {
    const lane = "test:inter-session-priority";
    setCommandLaneConcurrency(lane, 1);
    const { promise: blockerGate, resolve: releaseBlocker } = createDeferred();
    const blocker = enqueueCommandInLane(lane, async () => {
      await blockerGate;
    });
    const order: string[] = [];
    const interSession = enqueueCommandInLane(
      lane,
      async () => {
        order.push("inter-session");
      },
      {
        priority: resolveEmbeddedRunSessionLanePolicy("user", {
          kind: "inter_session",
          sourceTool: "sessions_send",
        }).priority,
      },
    );
    const foreground = enqueueCommandInLane(
      lane,
      async () => {
        order.push("foreground-user");
      },
      { priority: resolveEmbeddedRunSessionLanePolicy("user").priority },
    );

    releaseBlocker();
    await Promise.all([blocker, foreground, interSession]);

    expect(order).toEqual(["foreground-user", "inter-session"]);
  });
});
