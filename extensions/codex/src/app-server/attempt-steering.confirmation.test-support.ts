import { expect, it, vi } from "vitest";
import {
  CodexSteeringAcceptedUnconfirmedError,
  type createCodexSteeringQueue,
} from "./attempt-steering.js";
import type { createClientHarness } from "./test-support.js";

type QueueParams = Parameters<typeof createCodexSteeringQueue>[0];
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const confirmedId = (sequence = 1) => `openclaw:turn-1:steer:${sequence}`;

type ConfirmationCaseFixtures = {
  createQueue: (
    client: QueueParams["client"],
    options?: Partial<Pick<QueueParams, "requestTimeoutMs" | "signal">>,
  ) => ReturnType<typeof createCodexSteeringQueue>;
  createReplyHarness: () => ReturnType<typeof createClientHarness>;
};

/** Registers inside the steering suite so its fake-clock lifecycle stays authoritative. */
export function registerCodexSteeringConfirmationCases({
  createQueue,
  createReplyHarness,
}: ConfirmationCaseFixtures): void {
  it("bounds consumption confirmation after a successful steering acknowledgement", async () => {
    const harness = createReplyHarness();
    const queue = createQueue(harness.client, { requestTimeoutMs: 1_000 });
    const accepted = vi.fn();
    const settled = vi.fn();
    const outcomes: unknown[] = [];
    let next: Promise<void> | undefined;
    const delivery = queue
      .queue("synthetic follow-up", {
        debounceMs: 0,
        onQueueAccepted: accepted,
        onQueueSettled: settled,
      })
      .then(
        () => outcomes.push("resolved"),
        (error: unknown) => outcomes.push(error),
      );
    try {
      await tick();
      expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
      expect(outcomes).toEqual([]);
      await tick(1_000);
      expect(outcomes[0]).toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
      expect(settled).not.toHaveBeenCalled();
      // The caller's deadline cannot withdraw the receiving run's accepted input.
      expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
      expect(queue.getAcceptedMessages()).toHaveLength(1);
      expect(queue.confirmConsumed(confirmedId())).toBe(true);
      expect(settled).toHaveBeenCalledOnce();

      next = queue.queue("synthetic later follow-up", { debounceMs: 0 });
      await tick();
      expect(harness.writes).toHaveLength(2);
      expect(queue.confirmConsumed(confirmedId(2))).toBe(true);
      await next;
      await tick(1_000);
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      queue.cancel();
      harness.client.close();
      await Promise.allSettled([delivery, next]);
    }
  });

  it.each(["consume", "cancel"] as const)(
    "retains acknowledged queue-only custody past the deadline until %s",
    async (outcome) => {
      const harness = createReplyHarness();
      const queue = createQueue(harness.client, { requestTimeoutMs: 1_000 });
      const accepted = vi.fn();
      const settled = vi.fn();
      const delivery = queue.queue("synthetic queue-only message", {
        debounceMs: 0,
        waitForTranscriptCommit: false,
        onQueueAccepted: accepted,
        onQueueSettled: settled,
      });
      try {
        await tick();
        expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
        await delivery;
        await tick(10_000);
        expect(settled).not.toHaveBeenCalled();
        expect(queue.getAcceptedMessages()).toHaveLength(1);
        if (outcome === "cancel") {
          queue.cancel();
        }
        expect(queue.confirmConsumed(confirmedId())).toBe(outcome === "consume");
        expect(settled).toHaveBeenCalledOnce();
        queue.cancel();
        await tick(1_000);
        expect(harness.writes).toHaveLength(1);
        expect(settled).toHaveBeenCalledOnce();
      } finally {
        queue.cancel();
        harness.client.close();
        await delivery.catch(() => {});
      }
    },
  );
}
