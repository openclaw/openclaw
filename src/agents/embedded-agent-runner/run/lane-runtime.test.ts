import { afterEach, describe, expect, it } from "vitest";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../../sessions/input-provenance.js";
import { resolveEmbeddedRunSessionLanePolicy } from "./lane-runtime.js";

afterEach(() => {
  resetCommandQueueStateForTest();
});

describe("embedded run lane priority", () => {
  it("runs a foreground turn before queued recovery, inter-session work, and events", async () => {
    const lane = "test:restart-recovery-priority";
    setCommandLaneConcurrency(lane, 1);
    let releaseBlocker: () => void = () => {};
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = enqueueCommandInLane(lane, async () => {
      await blockerGate;
    });
    const order: string[] = [];
    const restartRecovery = enqueueCommandInLane(
      lane,
      async () => {
        order.push("restart-recovery");
      },
      {
        priority: resolveEmbeddedRunSessionLanePolicy("user", {
          kind: "internal_system",
          sourceTool: MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL,
        }).priority,
      },
    );
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
    const event = enqueueCommandInLane(
      lane,
      async () => {
        order.push("session-event");
      },
      { priority: resolveEmbeddedRunSessionLanePolicy("event").priority },
    );
    const foreground = enqueueCommandInLane(
      lane,
      async () => {
        order.push("foreground-user");
      },
      { priority: resolveEmbeddedRunSessionLanePolicy("user").priority },
    );

    releaseBlocker();
    await Promise.all([blocker, foreground, restartRecovery, interSession, event]);

    expect(order).toEqual([
      "foreground-user",
      "restart-recovery",
      "inter-session",
      "session-event",
    ]);
  });
});
