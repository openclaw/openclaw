import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  deliver,
  publishWakeTransition,
  registryRead,
  REQUESTER_KEY,
  settledChild,
  useRequesterSettleDispatchFixture,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

describe("requester settle dispatch park boundary", () => {
  useRequesterSettleDispatchFixture();

  it("never completes an ordinary batch on requester_turn_pending, so it cannot reach the settle park (#154252)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const child = settledChild();
    registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
    deliver.mockResolvedValue({
      delivered: false,
      path: "direct",
      disposition: "retryable",
      reason: "requester_turn_pending",
    });
    const completeBatch = vi.fn();
    for (let observation = 0; observation < 8; observation += 1) {
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled({
          isSourceCurrent: () => true,
          requesterSessionKey: REQUESTER_KEY,
          settledEntry: child,
          transitionBatch: publishWakeTransition,
          completeBatch,
        }),
      ).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(completeBatch).not.toHaveBeenCalled();
    expect(child.requesterSettleWake).toBeDefined();
    expect(child.suppressCompletionDelivery).not.toBe(true);
  });
});
